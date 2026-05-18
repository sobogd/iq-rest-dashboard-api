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
// Why scoped to restaurantId (not companyId): one company will own many
// restaurants soon (see multi-restaurant plan). Scoping now keeps the wire
// format stable and avoids cross-restaurant leaks.
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

    // Verify the requested restaurant belongs to the authed user's company.
    // Without this anyone with a session could subscribe to any restaurant's
    // event stream by id-guessing.
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { companyId: true },
    });
    if (!restaurant || restaurant.companyId !== req.authUser.companyId) {
      throw new BadRequestException("invalid restaurant");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Initial hello — also doubles as a connect probe for the client.
    res.write(`event: ready\ndata: {}\n\n`);

    const unsubscribe = this.events.subscribe(restaurantId, (event) => {
      try {
        res.write(`event: order\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client gone; cleanup on close handler.
      }
    });

    // 25s comment pings keep proxies (nginx, Cloudflare) from idling the conn.
    const ping = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        // ignore
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  }
}
