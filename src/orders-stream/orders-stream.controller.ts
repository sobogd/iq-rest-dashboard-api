import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersEventsService } from "./orders-events.service";

// Server-Sent Events stream for live order updates.
//
// Why SSE: dashboards/kitchen need server-pushed state; we don't need a
// bidirectional channel, so WebSocket overhead is unjustified. EventSource
// gives us native auto-reconnect for free.
//
// Scoped to restaurantId so cross-restaurant order events never leak — each
// paired tablet or dashboard tab subscribes to exactly one restaurant stream.
//
// Liveness: a typed `ping` event is sent every 15s. The client uses it as a
// watchdog — if no ping/order is observed for ~45s the client force-
// reconnects (catches dead-but-not-closed sockets behind some proxies).
const CLIENT_PING_INTERVAL_MS = 15_000;

@Controller("orders/stream")
export class OrdersStreamController {
  private readonly logger = new Logger(OrdersStreamController.name);

  constructor(
    private readonly events: OrdersEventsService,
    private readonly prisma: PrismaService,
  ) {}

  @UseGuards(AuthGuard)
  @Get()
  async stream(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query("restaurantId") restaurantId?: string,
  ): Promise<void> {
    if (!restaurantId) throw new BadRequestException("restaurantId required");

    // Per-restaurant model: a user can only subscribe to a restaurant they're
    // attached to via RestaurantUser.
    const membership = await this.prisma.restaurantUser.findUnique({
      where: { restaurantId_userId: { restaurantId, userId: req.authUser.userId } },
      select: { id: true },
    });
    if (!membership) {
      throw new BadRequestException("invalid restaurant");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Hint EventSource clients to retry quickly if the stream drops.
    res.flushHeaders();
    res.write(`retry: 2000\n\n`);

    // Initial hello — also doubles as a connect probe for the client.
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

    const unsubscribe = this.events.subscribe(restaurantId, (event) => {
      safeWrite(`event: order\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Typed ping the client treats as a liveness heartbeat.
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
