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
//
// Hardening against silent death (NAT/LB idle drops, half-open TCP):
//  - TCP keepAlive so the kernel notices a dead peer.
//  - Application-level health ping (SELECT 1) every 30s; on failure or
//    timeout we force a reconnect even if pg never emitted error/end.
//  - Heartbeat NOTIFY (own channel) every 30s; if we don't observe our own
//    heartbeat back within 90s we consider the LISTEN dead and reconnect.
const HEALTH_PING_INTERVAL_MS = 30_000;
const HEALTH_PING_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_STALE_MS = 90_000;
const HEARTBEAT_CHANNEL = `${ORDERS_NOTIFY_CHANNEL}_heartbeat`;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

@Injectable()
export class OrdersEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersEventsService.name);
  private client: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private lastHeartbeatAt = 0;
  private destroyed = false;
  private readonly subject = new Subject<OrderEvent>();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.clearTimers();
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.end().catch(() => {});
    }
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
    if (this.destroyed) return;
    const url = this.config.get<string>("DATABASE_URL");
    if (!url) {
      this.logger.error("DATABASE_URL missing — orders stream disabled");
      return;
    }
    let client: Client | null = null;
    try {
      client = new Client({
        connectionString: url,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
      });
      const owned = client;
      owned.on("notification", (msg) => {
        if (!msg.channel || !msg.payload) return;
        if (msg.channel === HEARTBEAT_CHANNEL) {
          this.lastHeartbeatAt = Date.now();
          return;
        }
        if (msg.channel !== ORDERS_NOTIFY_CHANNEL) return;
        try {
          const parsed = JSON.parse(msg.payload) as OrderEvent;
          this.subject.next(parsed);
        } catch (e) {
          this.logger.warn(`bad NOTIFY payload: ${String(e)}`);
        }
      });
      owned.on("error", (err) => {
        this.logger.error(`pg listener error: ${err.message}`);
        this.handleConnectionLost(owned);
      });
      owned.on("end", () => {
        this.logger.warn("pg listener connection ended; reconnecting");
        this.handleConnectionLost(owned);
      });
      await owned.connect();
      await owned.query(`LISTEN ${ORDERS_NOTIFY_CHANNEL}`);
      await owned.query(`LISTEN ${HEARTBEAT_CHANNEL}`);
      this.client = owned;
      this.reconnectAttempt = 0;
      this.lastHeartbeatAt = Date.now();
      this.startHealthLoops(owned);
      this.logger.log(`Listening on ${ORDERS_NOTIFY_CHANNEL}`);
    } catch (e) {
      this.logger.error(`pg LISTEN failed: ${(e as Error).message}`);
      if (client) await client.end().catch(() => {});
      this.scheduleReconnect();
    }
  }

  private startHealthLoops(owned: Client): void {
    this.clearHealthTimers();

    this.healthTimer = setInterval(() => {
      if (this.client !== owned) return;
      const timeout = setTimeout(() => {
        this.logger.warn("pg health ping timed out; forcing reconnect");
        this.handleConnectionLost(owned);
      }, HEALTH_PING_TIMEOUT_MS);
      owned
        .query("SELECT 1")
        .then(() => clearTimeout(timeout))
        .catch((err: Error) => {
          clearTimeout(timeout);
          this.logger.warn(`pg health ping failed: ${err.message}`);
          this.handleConnectionLost(owned);
        });
    }, HEALTH_PING_INTERVAL_MS);

    this.heartbeatTimer = setInterval(() => {
      if (this.client !== owned) return;
      const sinceLast = Date.now() - this.lastHeartbeatAt;
      if (sinceLast > HEARTBEAT_STALE_MS) {
        this.logger.warn(
          `heartbeat stale (${sinceLast}ms since last); forcing reconnect`,
        );
        this.handleConnectionLost(owned);
        return;
      }
      owned
        .query(`SELECT pg_notify($1, $2)`, [HEARTBEAT_CHANNEL, ""])
        .catch((err: Error) => {
          this.logger.warn(`heartbeat publish failed: ${err.message}`);
          this.handleConnectionLost(owned);
        });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private handleConnectionLost(owned: Client): void {
    if (this.client !== owned && this.client !== null) return;
    this.client = null;
    this.clearHealthTimers();
    owned.removeAllListeners();
    owned.end().catch(() => {});
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearHealthTimers(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHealthTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
