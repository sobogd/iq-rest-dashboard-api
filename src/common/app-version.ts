import type { Request, Response, NextFunction } from "express";

// Identifier the dashboard-web bundle compares against. We prefer an
// explicitly set BUILD_VERSION env var (the deploy pipeline can set it to
// the git SHA so the value flips only on real code releases); when it's
// missing we fall back to a per-process boot timestamp, which still flips
// on every restart and is good enough for "force a refresh after I deploy".
const APP_VERSION = process.env.BUILD_VERSION || `boot-${Date.now()}`;

export const APP_VERSION_HEADER = "X-App-Version";

// Express middleware over a Nest interceptor on purpose: interceptors only
// run when the request actually reaches a controller. Guards, pipes, and
// global exception filters all bypass the interceptor pipeline. A
// middleware runs on every response, so 401s, 403s, 4xx validation errors
// and 5xx crashes all carry the version header — which means a stale
// dashboard tab will pick up a new server version on the very next API
// round-trip regardless of how that round-trip ended.
export function appVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader(APP_VERSION_HEADER, APP_VERSION);
  next();
}

export function getAppVersion(): string {
  return APP_VERSION;
}
