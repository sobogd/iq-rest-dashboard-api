import { SetMetadata } from "@nestjs/common";
import type { DeviceAuth } from "./devices.service";

// Restricts a route (or whole controller) to specific paired-device types.
// Read by UserOrDeviceGuard: when a request authenticates as a device whose
// `type` is not in the allowed set, the guard throws 403. Cookie-session
// (admin) requests are unaffected — the check only runs for device tokens.
//
// Without this, any paired tablet (KITCHEN/WAITER/RESERVATION) could hit the
// full /orders and /reservations surface regardless of what its own UI uses.
export const DEVICE_TYPES_KEY = "allowedDeviceTypes";

export const DeviceTypes = (...types: DeviceAuth["type"][]) =>
  SetMetadata(DEVICE_TYPES_KEY, types);
