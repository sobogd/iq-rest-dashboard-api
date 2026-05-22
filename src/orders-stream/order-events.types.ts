// Shape of the JSON payload pushed through Postgres NOTIFY → SSE clients.
// Kept tiny on purpose — clients always have the full order objects from
// their initial fetch and apply mutations / delete by id.

export type OrderEventAction =
  | "created"
  | "updated"
  | "deleted"
  | "split"
  | "device-revoked"
  | "force-reload";

export interface OrderItemSummary {
  id: string;
  dishId: string;
  status: string;
}

export interface OrderEvent {
  action: OrderEventAction;
  restaurantId: string;
  // Full order payload for created / updated / split.source / split.created.
  order?: unknown;
  // Set when action === "split" — the spun-off order alongside the updated source.
  createdOrder?: unknown;
  // Set when action === "deleted".
  orderId?: string;
  // Set when action === "device-revoked". The receiving tablet matches this
  // against its own deviceId and force-logs-out on hit. Piggybacks on the
  // orders SSE channel so kitchen UIs don't need a second EventSource.
  deviceId?: string;
  // Slim-mode kitchen summary. When the full order body would exceed the
  // pg_notify 8000-char limit, the publisher drops `order` and ships
  // this instead so the kitchen kiosk can still diff item ids + check
  // its chime filter without round-tripping for a full bootstrap.
  itemSummary?: OrderItemSummary[];
}

export const ORDERS_NOTIFY_CHANNEL = "orders_events";
