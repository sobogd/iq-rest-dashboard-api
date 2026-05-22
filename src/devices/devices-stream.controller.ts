import { BadRequestException, Controller, Get, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { DevicesService } from "./devices.service";
import { OrdersEventsService } from "../orders-stream/orders-events.service";

// SSE stream scoped to a paired device.
//
// Why a dedicated endpoint (not the existing /orders/stream): EventSource
// cannot set an Authorization header, so device auth has to ride a query
// param. Keeping that surface out of the admin /orders/stream avoids any
// risk of the admin SSE accidentally accepting device tokens via query
// shadowing, and lets each side filter events according to its own rules.
//
// The kitchen UI subscribes here. Event filtering:
//   - Order events: every event for the device's restaurantId is forwarded.
//   - `device-revoked` events: forwarded only when deviceId matches us, so
//     other devices on the same restaurant don't observe each other's
//     revocations.
const CLIENT_PING_INTERVAL_MS = 15_000;

@Controller("devices/stream")
export class DevicesStreamController {
  constructor(
    private readonly devices: DevicesService,
    private readonly events: OrdersEventsService,
  ) {}

  @Get()
  async stream(
    @Req() req: Request,
    @Res() res: Response,
    @Query("token") token?: string,
  ): Promise<void> {
    if (!token) throw new BadRequestException("token required");
    const auth = await this.devices.resolveByToken(token);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(`retry: 2000\n\n`);
    res.write(`event: ready\ndata: {}\n\n`);

    let closed = false;
    const safeWrite = (chunk: string): boolean => {
      if (closed) return false;
      try {
        return res.write(chunk);
      } catch {
        return false;
      }
    };

    void this.devices.heartbeat(auth.deviceId).catch(() => undefined);

    const unsubscribe = this.events.subscribe(auth.restaurantId, (event) => {
      if (event.action === "device-revoked") {
        // Only the targeted tablet should see its own revocation event,
        // even though every connected client on this restaurant receives
        // the underlying NOTIFY broadcast.
        if (event.deviceId !== auth.deviceId) return;
        safeWrite(`event: device-revoked\ndata: ${JSON.stringify(event)}\n\n`);
        return;
      }
      if (event.action === "force-reload") {
        // Admin-triggered "reload every paired tablet" — used to push
        // hotfixed bundles without walking the floor.
        safeWrite(`event: force-reload\ndata: ${JSON.stringify(event)}\n\n`);
        return;
      }
      safeWrite(`event: order\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const ping = setInterval(() => {
      safeWrite(`event: ping\ndata: ${Date.now()}\n\n`);
    }, CLIENT_PING_INTERVAL_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }
}
