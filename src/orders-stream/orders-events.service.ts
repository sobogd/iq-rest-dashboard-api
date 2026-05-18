import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client } from "pg";
import { Subject } from "rxjs";
import {
  ORDERS_NOTIFY_CHANNEL,
  OrderEvent,
} from "./order-events.types";

// Dedicated long-lived pg client that LISTENs on the orders channel. Prisma's
// connection pool is not suitable because LISTEN is per-connection, and
// Prisma may rotate connections. Reconnects forever on failure — this
// listener is critical: if it dies, every dashboard tab silently goes stale.
@Injectable()
export class OrdersEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersEventsService.name);
  private client: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly subject = new Subject<OrderEvent>();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.client) await this.client.end().catch(() => {});
  }

  // Subscribe to order events for a given restaurant. Each call gets its own
  // filtered observable; the underlying pg LISTEN is shared.
  subscribe(restaurantId: string, handler: (event: OrderEvent) => void): () => void {
    const sub = this.subject.subscribe((event) => {
      if (event.restaurantId === restaurantId) handler(event);
    });
    return () => sub.unsubscribe();
  }

  // Writes to Postgres NOTIFY so every dashboard-api instance (PM2 cluster)
  // sees it on its own LISTEN, then fans out to its local SSE clients.
  // Payload must fit pg's 8000-char NOTIFY limit; truncated payloads strip
  // the heavy body and clients fall back to a full refetch.
  async publish(event: OrderEvent): Promise<void> {
    if (!this.client) {
      this.logger.warn("publish skipped — pg listener not connected");
      return;
    }
    const payload = JSON.stringify(event);
    if (payload.length > 7800) {
      // Postgres NOTIFY hard limit is 8000 bytes. Strip the heavy `order`
      // body and rely on the client refetching to fill in the gap.
      const slim: OrderEvent = {
        action: event.action,
        restaurantId: event.restaurantId,
        orderId: event.orderId,
      };
      await this.client.query(`SELECT pg_notify($1, $2)`, [
        ORDERS_NOTIFY_CHANNEL,
        JSON.stringify(slim),
      ]);
      return;
    }
    await this.client.query(`SELECT pg_notify($1, $2)`, [ORDERS_NOTIFY_CHANNEL, payload]);
  }

  private async connect(): Promise<void> {
    const url = this.config.get<string>("DATABASE_URL");
    if (!url) {
      this.logger.error("DATABASE_URL missing — orders stream disabled");
      return;
    }
    try {
      const client = new Client({ connectionString: url });
      client.on("notification", (msg) => {
        if (msg.channel !== ORDERS_NOTIFY_CHANNEL || !msg.payload) return;
        try {
          const parsed = JSON.parse(msg.payload) as OrderEvent;
          this.subject.next(parsed);
        } catch (e) {
          this.logger.warn(`bad NOTIFY payload: ${String(e)}`);
        }
      });
      client.on("error", (err) => {
        this.logger.error(`pg listener error: ${err.message}`);
        this.scheduleReconnect();
      });
      client.on("end", () => {
        this.logger.warn("pg listener connection ended; reconnecting");
        this.scheduleReconnect();
      });
      await client.connect();
      await client.query(`LISTEN ${ORDERS_NOTIFY_CHANNEL}`);
      this.client = client;
      this.logger.log(`Listening on ${ORDERS_NOTIFY_CHANNEL}`);
    } catch (e) {
      this.logger.error(`pg LISTEN failed: ${(e as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.client = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2000);
  }
}
