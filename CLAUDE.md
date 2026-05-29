# iq-rest-dashboard-api

NestJS + Prisma backend for the IQ Rest dashboard (`dashboard.iq-rest.com`). Owns the shared Postgres schema and migrations; serves the dashboard SPA (`iq-rest-dashboard-web`) and paired tablet devices (KDS, waiter, reservation kiosks); receives anonymous tracking events from the landing; handles Stripe billing, OAuth (Google/Apple/OTP), Google Ads ops, scan-menu (Gemini), translations, and S3 uploads.

> **Schema cleanup 2026-05-28 (Stage C).** The `Company` entity, `UserCompany`, `RestaurantAccess` and `GoogleAdsExclusion` tables were dropped from Postgres. Per-restaurant billing is now the model — each `Restaurant` carries its own `plan`, `billingCycle`, `subscriptionStatus`, `currentPeriodEnd`, `paymentProcessing`, `stripeSubscriptionId`, `trialEndsAt`. The `User.stripeCustomerId` is the one Stripe customer per human; restaurants attach via the flat `RestaurantUser` table (`addedBy === null` ⇒ owner, otherwise manager/`viaGrant`). All `companyId` columns are gone (see migration `20260528200000_drop_legacy_company`). The text below has been refreshed to match — anything that still mentions Company, UserCompany, RestaurantAccess or companyId is a stale comment that should be cleaned up. See `/home/deploy/dev/AUDIT_2026-05-29.md` for the full audit + open follow-ups.

## Build rule on this server (read first)

This server has ~3.7 GB RAM. **DO NOT run production builds here**:

- Forbidden: `npm run build`, `nest build`, `npm run start:prod`.
- Allowed for type checks: `npx tsc --noEmit`.
- Allowed: `npm run dev`, `npm run lint`, `npm run test`, `npm run prisma:generate`, `npm run prisma:deploy`.
- All production builds happen in GitHub Actions on push; artifacts deploy to `/home/deploy/apps/iq-rest-dashboard-api/` and PM2 runs them as `dashboard-api` on port 8130.

## Where it fits in IQ Rest

```
Browsers (dashboard.iq-rest.com)            tablets (KDS/waiter/reservation)
        |                                          |
        |  cookie session                          |  Bearer device JWT
        v                                          v
[iq-rest-dashboard-web]  <----- HTTP + SSE -----> [iq-rest-dashboard-api]  <--- pg LISTEN/NOTIFY ---  [iq-rest-public-menu-api]
                                                          |                                                  ^
                                                          v                                                  | diner orders/bookings
                                                  [Postgres (shared schema)]  <--------------------- [iq-rest-public-menu]
                                                          ^
                                                          | track events
                                                  [iq-rest-landing] (legacy)
```

Real-time order/booking events ride Postgres `LISTEN/NOTIFY` on channel `orders_events`. `iq-rest-public-menu-api` and this service both publish; this service listens (single long-lived `pg` client) and fans events out to dashboard SSE clients and paired tablets.

## Tech stack

- **NestJS 10** (`@nestjs/common/core/platform-express/config/jwt/throttler/schedule`)
- **Prisma 6** (owner of the schema and migrations)
- **PostgreSQL** via `pg` (raw `Client` for LISTEN/NOTIFY; Prisma everywhere else)
- **Stripe SDK** (subscriptions + webhooks)
- **AWS SDK v3 / S3** + `sharp` for image processing (Hetzner Object Storage)
- **argon2** (password / OTP hashing)
- **Google Auth library** (Google OAuth code-exchange + id-token verify)
- **Apple OAuth** (`apple-auth.ts` handles client-secret JWT + token endpoint)
- **Gemini API** (image generation, menu scanning, translations) — REST, no SDK
- **class-validator** + **class-transformer** (DTOs); **zod** used in a couple of spots
- **helmet**, **cookie-parser**, **ua-parser-js**, **isbot**
- **TypeScript 5**, Node 22 / 20

## Repository layout

```
src/
  main.ts                           # bootstrap (rawBody, helmet, cookies, CORS, body limits, ValidationPipe)
  app.module.ts                     # root module + global ThrottlerGuard
  health/health.controller.ts       # GET /api/health
  common/
    all-exceptions.filter.ts
    app-version.ts                  # appVersionMiddleware + APP_VERSION_HEADER (X-App-Version)
    session-utils.ts                # cookie option helpers
    geo.ts                          # getRequestCountry / getRequestCurrency (Cloudflare headers)
    ai-quota.ts                     # consumeAiImageQuota / refundAiImageUsage / isPaidActive
    gemini-image.ts                 # callGeminiImage + uploadGeneratedImage (sharp resize → S3)
    stripe.ts                       # getStripe + PRICE_LOOKUP_KEYS
    reserved-slugs.ts
    validate-email.ts
  prisma/                           # PrismaModule + PrismaService (extends PrismaClient)
  auth/                             # OAuth + OTP + session
  restaurant/                       # /restaurant + /restaurants (multi-restaurant)
  categories/  items/  tables/      # menu CRUD
  reservations/                     # owner-side reservation board
  orders/  orders-stream/           # in-house orders + SSE
  devices/                          # tablet pairing + JWT + SSE
  upload/                           # POST /upload  (S3 + sharp)
  translate/  auto-translate/       # Gemini translation API + bulk service
  scan-menu/                        # Gemini menu OCR (image / PDF → categories+items)
  stripe/                           # checkout / portal / webhook
  geo/                              # GET /geo/currency
  analytics/                        # GET /analytics/stats (dashboard analytics)
  usage/                            # POST /track/:event (landing/dashboard usage events)
  support/                          # GET/POST /support/messages
  admin/                            # /admin/* — internal-only ops + Google Ads management
  mail/
    mail.module.ts
    mail.service.ts
    templates/                      # welcome-personal, menu-almost-ready, trial-ending, reservation-status
  i18n/                             # 37 locale JSONs + i18n.service.ts (server-side translations for emails)
  onboarding/                       # cuisine.ts, cuisine-templates.ts, cuisine-translations.json,
                                    # cuisine-template-images.json + onboarding-seed.service.ts
prisma/
  schema.prisma                     # 17 models — owner of migrations
  migrations/
scripts/                            # one-off node/SQL scripts (backfill, fb-capi-test, generate template images, ...)
.env.example
nest-cli.json  tsconfig.json  tsconfig.build.json
```

## Commands

```bash
npm run dev               # nest start --watch
npm run start             # nest start
npm run start:debug       # nest start --debug --watch
npm run lint              # eslint --fix
npm run test              # jest
npm run test:watch        # jest --watch
npx tsc --noEmit          # type-check (use instead of build)
npm run prisma:generate   # prisma generate
npm run prisma:migrate    # prisma migrate dev   (dev-only — never run against prod DB)
npm run prisma:deploy     # prisma migrate deploy
npm run prisma:studio     # prisma studio
```

**FORBIDDEN on this server:** `npm run build`, `nest build`, `npm run start:prod`. GitHub Actions handles all builds.

## Environment variables

Authoritative list — from `.env.example` plus runtime reads (`ConfigService.get(...)`):

| Var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `4000` (compose: `8130`) |
| `NODE_ENV` | env name | `development` |
| `DATABASE_URL` | Postgres DSN (shared with public-menu-api) | required |
| `JWT_SECRET` | signs device JWTs and OAuth state tokens | `change-me` |
| `JWT_EXPIRES_IN` | JWT TTL | `7d` |
| `COOKIE_NAME` | (legacy/unused — actual name `iqr_session` is hardcoded) | `iqr_session` |
| `COOKIE_DOMAIN` | session cookie `Domain` | empty (single host) |
| `COOKIE_SECURE` | session cookie `Secure` | `false` |
| `CORS_ORIGINS` | comma-separated allowed origins | `http://localhost:8129,https://iq-rest.com,https://dashboard.iq-rest.com` |
| `ANALYTICS_COOKIE_DOMAIN` | apex domain for shared analytics cookie (e.g. `.iq-rest.com` in prod) | empty in dev |
| `APP_URL` | dashboard base URL (Stripe success/cancel) | `http://localhost:8129` |
| `LANDING_URL` | landing base (OAuth redirect targets) | `https://iq-rest.com` |
| `DASHBOARD_URL` | dashboard base (OAuth redirect targets, owner-email links) | `https://dashboard.iq-rest.com` |
| `API_PUBLIC_URL` | this service's public base URL (OAuth redirect_uri) | `https://dashboard-api.iq-rest.com` |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `FROM_EMAIL` | nodemailer | none → email skipped |
| `S3_HOST` `S3_KEY` `S3_TOKEN` `S3_NAME` `S3_REGION` | Hetzner Object Storage | none → uploads fail |
| `GEMINI_API_KEY` | Google Gemini (image gen, menu OCR, translate) | none |
| `STRIPE_SECRET_KEY` | Stripe API key | none → billing disabled |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | none → webhook rejected |

## Bootstrap (`src/main.ts`)

- `NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true })` — `rawBody: true` is required by the Stripe webhook signature check (`req.rawBody` Buffer).
- `helmet({ contentSecurityPolicy: false, strictTransportSecurity: false, crossOriginResourcePolicy: false })`
- `cookieParser()`
- `appVersionMiddleware` — stamps every response with `X-App-Version` so the dashboard can detect redeploys and self-refresh at a safe moment.
- `app.useBodyParser("json", { limit: "500mb" })` + same for `urlencoded` — large limit is for the scan-menu base64 uploads (up to 5 × 20 MB images). Note: re-registering bodyParser via `app.use` here is intentionally avoided (would consume the stream twice and break every POST).
- CORS: origins from `CORS_ORIGINS` (or `true` if empty), `credentials: true`, `exposedHeaders: ["x-app-version"]` so the SPA can read the version header cross-origin.
- `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false })`.
- Global `AllExceptionsFilter`.
- Global prefix `api` → all routes below are `/api/<route>`.
- Listens on `PORT` (default 4000; in prod 8130).

## Throttling

Global guard: 600 req / 60s per IP (`{ name: "default", ttl: 60_000, limit: 600 }`). Per-route override on `POST /api/track/:event`: 10/s burst + 200/min sustained.

## Modules and endpoints

> Routes below are written with the `/api` prefix omitted. Add `/api/` in front.

### Health
- `GET /health` → `{ ok, time }`

### Auth (`src/auth/`)
Cookies set on the response: `iqr_session` (httpOnly, signed JWT-ish opaque token), `iqr_email` (not httpOnly — UI reads it), plus legacy mirrors `session` and `user_email` for the old monolith.

- `POST /auth/send-otp` — body `{ email, locale?, signupContext? }`. Generates and emails an OTP. Captures `signupContext` (cuisine + restaurantName), the locale, and currency (Cloudflare-derived) onto `User.pendingCuisine` etc. so a brand-new account gets a seeded template restaurant on first verify. Returns `{ ok, isNewUser }`.
- `POST /auth/verify-otp` — body `{ email, code }`. On success sets all four session cookies and returns `{ ok, onboardingStep, isNewUser, legacyDashboard }`.
- `POST /auth/google` — body `{ credential? | code?, signupContext?, locale? }`. Accepts either a Google id_token (`credential`) or an auth-code (`code`) — auth-code is exchanged via `auth.exchangeGoogleCode`. Sets cookies and returns user info.
- `GET /auth/google/callback?code=&state=&error=` — full-page redirect OAuth flow. Decodes base64url `state` → `{ locale, signupContext }`, exchanges the code with `redirect_uri=${API_PUBLIC_URL}/api/auth/google/callback`, sets cookies, then 302 → `${landingBase}/${locale}/dashboard` (legacy) or `${dashboardBase}/${locale}/dashboard` (new SPA).
- `POST /auth/apple/callback` — Apple uses `response_mode=form_post`, so the body arrives urlencoded with `code`, `state`, optional `user` JSON (name, first-auth only) and optional `error`. Same flow as Google callback.
- `POST /auth/logout` — clears all session cookies (including impersonation cookies `iqr_admin_original_*`). Resolves the right user to log out when inside admin-impersonation.
- `GET /auth/check` — used by the SPA to bootstrap session state. Returns `{ authenticated, email, userId, onboardingStep, impersonatedBy }`. (`legacyDashboard` is retired — landing still reads it for backward compat but the API always returns `false` if it surfaces.)

Auth machinery:
- `auth.guard.ts` — `AuthGuard` resolves cookies → `req.authUser = { userId, email, restaurantId, primaryRestaurantId, viaGrant, onboardingStep }`. The active restaurant is picked from the user's `RestaurantUser` rows (sorted by `addedAt`) — `restaurantId` is the chosen attachment, `primaryRestaurantId` is the first (signup default). `viaGrant=true` when `RestaurantUser.addedBy !== null` (attached as a manager); blocks billing/delete.
- `auth.service.ts` — full OAuth code-exchange + id_token verify + OTP send/verify + session resolve + impersonation helpers. `resolveSession` is the canonical session check used by `AuthGuard`, `UserOrDeviceGuard`, and analytics tracking.
- `apple-auth.ts` — client-secret JWT signing for Apple's `/auth/token`.

### Restaurant (`src/restaurant/`)
All endpoints `@UseGuards(AuthGuard)`.

- `GET /restaurant` — active restaurant of the user (or first of the company if no active id).
- `POST /restaurant` — upsert active restaurant. New restaurants get `currency` from Cloudflare + `timezone` from `cf-timezone` (validated via `Intl.DateTimeFormat`).
- `PUT /restaurant/languages` — `{ languages, defaultLanguage }`.
- `POST /restaurant/generate-background` — `{ prompt? }`. Builds a Gemini image prompt (vertical 9:16 dark moody background). If no prompt, picks 6 of the menu items and asks for a flat-lay. Consumes AI image quota, refunds on failure for free-tier users. Stored as `bg.<ts>.webp` at 1080×1920 in `restaurants/<restaurantId>/`.
- `POST /restaurant/dismiss-scan-banner` — sets `scanBannerDismissed=true`.
- `GET /restaurant/subscription` — plan, billingCycle, status, trialEndsAt, paymentProcessing, AI image quota; `canManageBilling=false` when `viaGrant`. Read straight off `Restaurant.*` (no Company hop).

Multi-restaurant:
- `GET /restaurants/slug-preview?name=` — preview generated slug.
- `GET /restaurants` — list owned + granted restaurants (with `activeId`, `isPaid`, `canManageBilling`).
- `POST /restaurants` — `{ name, duplicateFromId? }`. Creates under the user's own company, auto-switches `iqr_active_restaurant_id` cookie (1y).
- `POST /restaurants/active` — `{ id }`. Sets active-restaurant cookie. Allowed for any restaurant the user is attached to via `RestaurantUser` (owned or manager — distinction only matters for billing/delete gates).
- `DELETE /restaurants/:id` — owner-only (granted access can't delete).

### Categories (`src/categories/`) — `@UseGuards(AuthGuard)`
- `GET /categories`
- `POST /categories`
- `PUT /categories/:id`
- `DELETE /categories/:id`
- `POST /categories/reorder`

### Items (`src/items/`) — `@UseGuards(AuthGuard)`
- `GET /items`
- `POST /items`
- `PUT /items/:id`
- `PATCH /items/:id`
- `DELETE /items/:id`
- `POST /items/reorder` — single move
- `POST /items/reorder-bulk` — full new order
- `POST /items/generate-image` — `{ name?, description?, categoryName?, accentColor?, sourceImageUrl?, prompt? }`. Either generates from scratch (1:1, top-down food photo) or restyles a `sourceImageUrl` (must be from our own S3 — SSRF guard). Consumes AI image quota.

### Tables (`src/tables/`) — `@UseGuards(AuthGuard)`
- `GET /tables`
- `POST /tables`
- `PUT /tables/:id`
- `DELETE /tables/:id`

### Reservations (`src/reservations/`) — `@UseGuards(UserOrDeviceGuard) @DeviceTypes("RESERVATION")`
Accepts either a cookie-session admin or a paired RESERVATION tablet token. KITCHEN/WAITER tablets are rejected.
- `GET /reservations`
- `PATCH /reservations/:id` — set status (pending|confirmed|cancelled|completed)
- `DELETE /reservations/:id`

### Orders (`src/orders/`) — `@UseGuards(UserOrDeviceGuard) @DeviceTypes("WAITER")`
Cookie-session admin OR paired WAITER device. KITCHEN flips item statuses through the narrower `PATCH /devices/orders/:id` endpoint (see Devices).
- `GET /orders?status=&from=&to=&open=1`
- `POST /orders`
- `PATCH /orders/:id`
- `POST /orders/:id/split`
- `POST /orders/:id/reopen`
- `DELETE /orders/:id` (204)

### Orders stream (`src/orders-stream/`)
- `GET /orders/stream?restaurantId=` — `@UseGuards(AuthGuard)` — Server-Sent Events for live order updates. Validates the restaurant belongs to the user's company. Headers force no-buffering (`X-Accel-Buffering: no`); ping event every 15s (client treats >45s without ping/order as dead and reconnects).
- Backed by `OrdersEventsService` (`orders-events.service.ts`) — owns a dedicated long-lived `pg` `Client` that `LISTEN`s on channel `orders_events` (and `orders_events_heartbeat`). Hardened against silent disconnects (TCP keepalive + app-level `SELECT 1` health ping every 30s with 5s timeout + self-heartbeat `pg_notify` every 30s with 90s staleness check + exponential reconnect 1s → 30s). Per-restaurant subscriber sharding (`Map<restaurantId, Set<handler>>`) so dispatch cost is O(subscribers for that restaurant), not O(total clients). `publish(event)` truncates payloads >7800 chars to `{action, restaurantId, orderId, itemSummary}` so kitchen clients can still diff item ids + run the chime filter without a full refetch.

### Devices (`src/devices/`)

Three device types: `KITCHEN`, `WAITER`, `RESERVATION` (enum on `Device.type`).

Admin (cookie session, `@UseGuards(AuthGuard)`):
- `GET /devices` — list company devices
- `POST /devices` — `{ name, type, restaurantId? }` — creates device + 6-digit pairing code (TTL 120s)
- `POST /devices/:id/regenerate-code`
- `POST /devices/:id/revoke` — sets status REVOKED, bumps `tokenVersion`, emits `device-revoked` SSE event
- `DELETE /devices/:id`

Public (no auth — pairing code is the credential):
- `POST /devices/pair` — `{ code }` — consumes code, returns long-lived device JWT.

Device (Bearer device JWT, `@UseGuards(DeviceGuard)`):
- `GET /devices/bootstrap` — single snapshot the kitchen UI needs on boot: `{ device, restaurant, categories, items, tables, orders, reservations }`. For RESERVATION devices skips the orders query and pulls reservations; for KITCHEN/WAITER skips reservations and asks for `open=true` orders only.
- `GET /devices/me` — updates `lastSeenAt` heartbeat, returns device id/restaurant/company/type
- `PATCH /devices/orders/:id` — kitchen-scoped order patch: whitelisted to `{items, total, discount}` only (any other key 400s); RESERVATION devices rejected.

Device SSE:
- `GET /devices/stream?token=` — `token` query param (EventSource can't set Authorization). Filters events from `OrdersEventsService`:
  - `device-revoked` — forwarded only when `event.deviceId === auth.deviceId`
  - `force-reload` — forwarded as-is (admin push to update bundles)
  - everything else → `event: order`
- Ping every 15s.

### Upload (`src/upload/`) — `@UseGuards(AuthGuard)`
- `POST /upload` (multipart `file`) — 25 MB max.
  - Images (jpeg/png/webp, not gif) → `sharp().rotate().resize(1200, fit:inside).sharpen().webp(80)`.
  - GIFs / videos (mp4/webm/quicktime) — uploaded raw.
  - Stored under `temp/<restaurantId>/<ts>-<rand>.<ext>` in S3 with `public-read` + `Cache-Control: public, max-age=31536000, immutable`.

### Translate (`src/translate/`) — `@UseGuards(AuthGuard)`
- `POST /translate` — `{ text, targetLanguage, sourceLanguage? }`. Calls `gemini-2.5-flash:generateContent` directly via fetch (`x-goog-api-key`). 35-language code → name map. Used by the dashboard's "Translate with AI" button.

### Auto-translate (`src/auto-translate/`)
- `AutoTranslateService` — bulk/back-fill translator for items+categories when a new locale is added; orchestrates many Gemini calls with retries. (No HTTP controller — invoked from other services.)

### Scan-menu (`src/scan-menu/`) — `@UseGuards(AuthGuard)`
Gemini-based menu OCR for the "Upload your paper menu" flow.
- `POST /scan-menu/parse` — `{ images?: string[], image? }` — up to 5 data-URLs (PNG/JPEG/WebP or PDF), each ≤20 MB. Fans out to `gemini-2.5-flash` in parallel with a system prompt that returns strict JSON `{ categories: [{ name, items: [{ name, price, description? }] }] }` or `{ error: "not_a_menu" }`. Originals saved to S3 under `scan_onboarding/<restaurantId>/`. Merges results case-insensitively by category name.
- `POST /scan-menu/save` — `{ categories, replaceExisting? }`. Deletes example items, optionally wipes existing menu, removes empty categories, creates new ones, sets `checklistMenuEdited=true` + `fromScanner=true` on the restaurant.

### Stripe (`src/stripe/`)
- `POST /stripe/checkout` — `@UseGuards(AuthGuard)`. `{ priceLookupKey, locale?, currency? }`. EU-only EUR billing. Scoped to the **active restaurant**. Existing ACTIVE subscription on this restaurant → routes to the Billing Portal so proration shows before commit. Otherwise reuses (or creates) the per-human `User.stripeCustomerId` and opens a Checkout Session with `metadata.restaurantId + metadata.userId`. Sets `Restaurant.paymentProcessing=true`. `viaGrant` users are 403'd — only owners manage billing.
- `POST /stripe/processing` — flips `paymentProcessing=true` (UI signal).
- `POST /stripe/portal` — opens Stripe Billing Portal session.
- `POST /stripe/webhook` — verifies via `stripe.webhooks.constructEvent(req.rawBody, signature, STRIPE_WEBHOOK_SECRET)`. Handles `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_succeeded/failed`. `applySubscription` maps `lookup_key` → `Plan` + `BillingCycle` and `sub.status` → `SubscriptionStatus`, writes `currentPeriodEnd`. Cancels any old subscription if a new one is created for the same company.

### Geo (`src/geo/`)
- `GET /geo/currency` — `{ country, currency }` from Cloudflare headers (`cf-ipcountry`, `cf-region`) via `common/geo.ts`.

### Analytics (`src/analytics/`) — `@UseGuards(AuthGuard)`
- `GET /analytics/stats?period=&scope=` — period is `today` | `week` | `YYYY-MM` (default current UTC month); `scope=all` aggregates across every restaurant the caller **owns** (`RestaurantUser.addedBy === null`) — manager-only attachments are not included so a contractor never sees the owner's other venues; forced to single-restaurant when the active restaurant itself is via grant. Returns `accountCreatedAt` (the earliest owned restaurant's createdAt) for the month-list picker. Returns:
  - `totalViews`, `totalScans` (distinct sessionId)
  - `byDay` + `byDayPrev` (densified to every day in range)
  - `byLanguage`, `byPage`
  - `orders`: `{ revenue, revenuePrev, ordersCount, aov, itemsPerOrder, currency: "EUR", byDay, byDayPrev, byHour (24 buckets), topByRevenue (10), topByQuantity (10), sizeBuckets {"1","2-3","4-5","6+"}, paymentMethods, byPaymentMethod }`
  - Uses `Prisma.$queryRaw` with parametrised `Prisma.sql` fragments for scope.

### Usage (`src/usage/`) — public
- `POST /track/:event?r=<referrer-host>` — throttled 10/s burst + 200/min sustained.
  - Event name must match `/^[a-z0-9_]{1,64}$/` **or** the paid-ads-only patterns `^l_gclid_[A-Za-z0-9_-]{1,256}$` / `^l_fbclid_[A-Za-z0-9_.-]{1,512}$`.
  - Bot detection: `isbot()` + an extra regex (AdsBot, HeadlessChrome, axios/node-fetch, http_request, …). Paid-ads events bypass bot filtering — every paid click is recorded regardless of UA.
  - Skips events when:
    - Admin is currently impersonating another user (`iqr_admin_original_session` cookie present).
    - Authenticated company is the internal `support@iq-rest.com` admin (`cmi5yzq5v0000vx0hbjmbks82`).
  - Looks up referrer hostname against a search-engine regex (google/bing/yandex/duckduckgo/yahoo/baidu/ecosia/qwant/startpage/mojeek/brave) to set `is_search`.
  - Anonymises IP (last IPv4 octet → 0, IPv6 truncated to /64).
  - Persists `UsageEvent` with country (`cf-ipcountry`), region (`cf-region`), device, platform, is_google_ads, is_facebook_ads, is_search, userId (from session cookie when logged in), restaurantId (from `iqr_active_restaurant_id` cookie when present), ip.
  - Returns 204.

### Support (`src/support/`) — `@UseGuards(AuthGuard)`
- `GET /support/messages` — chat history for the company.
- `POST /support/messages` — `{ message }` (max 2000 chars). Persists message and fires a fire-and-forget admin email notification (`MailService.sendAdminSupportNewMessageNotification`).

### Admin (`src/admin/`) — `@UseGuards(AdminGuard)`
Internal-only ops surface (~4 000 lines). Routes include:

- `POST /admin/devices/reload-all` — broadcast force-reload to every paired tablet (post-hotfix bundle push).
- `GET /admin/companies` / `GET /admin/companies/:id` / `DELETE /admin/companies/:id` — company management; 30-day usage windows aligned to UTC for consistency with the analytics dashboard.
- (`/admin/restaurant-grants/*` was removed in Stage C alongside the `RestaurantAccess` table. Attach/detach uses `POST/DELETE /admin/restaurants/:id/users[...]`; a `RestaurantUser` row with `addedBy = <admin id>` represents the manager-style attachment — **see the audit's CRIT-1: today the admin endpoint writes `addedBy: NULL` which incorrectly grants owner rights**.)
- `GET / POST /admin/companies/:id/messages` — admin-side support chat.
- `POST /admin/companies/:id/send-email` — sends a templated/custom email to a company.
- `POST /admin/impersonate` / `POST /admin/impersonate/exit` — stores the admin's original cookies under `iqr_admin_original_*`.
- `GET /admin/usage/timeline`, `GET /admin/usage/similar/:id`, `POST /admin/usage/events/delete`, `POST /admin/usage/events/link-company`, `POST /admin/companies/:id/gclid`, `POST /admin/companies/:id/send-conversion`, `POST /admin/usage-events/:id/fb-send` — Meta CAPI + Google Ads conversion uploads.
- `GET /admin/google-ads/page-*` and `/admin/google-ads/detail/*` — comprehensive Google Ads management UI: campaigns, ad-groups, ads, keywords, negatives, search terms, planner, sitelinks, callouts, snippets, images, bid management.
- `POST /admin/google-ads/keyword/:adGroupId` etc. — mutation endpoints for the Google Ads surface.

`admin.guard.ts` gates the whole module on the admin company id.

### Mail (`src/mail/`)
- `MailService` — nodemailer (pooled), used by reservations, support, admin email actions, trial-ending, welcome, menu-almost-ready campaigns.
- `templates/` — `welcome-personal.ts`, `menu-almost-ready.ts`, `trial-ending.ts`, `reservation-status.ts` (HTML/text builders).
- `i18n/` — 37 locale JSONs loaded by `i18n.service.ts` for email subject/body translation.

### Onboarding seed (`src/onboarding/`)
- `cuisine.ts` + `cuisine-templates.ts` + `cuisine-translations.json` + `cuisine-template-images.json` — built-in cuisine-typed menu templates (`Italian`, `Japanese`, etc.) with translated dish names and preset image URLs.
- `OnboardingSeedService` — invoked from `AuthService.verifyOtp`/Google/Apple on first sign-in of a brand-new account: creates Restaurant + RestaurantUser (`addedBy: null`) + sample categories + sample items + sample tables + sample reservations based on `pendingCuisine` / `pendingRestaurantName` / `pendingCurrency` (or default template if no cuisine was specified). The seed sets `plan: FREE, subscriptionStatus: INACTIVE, trialEndsAt: now+14d` so the very first restaurant gets a 14-day trial; subsequent restaurants created via `RestaurantService.createForCompany` (legacy name) start FREE with no trial.

## Prisma models (`prisma/schema.prisma`, 13 models, this service owns migrations)

| Model | Purpose |
|---|---|
| `User` | Human accounts. Stores OTP + hashed `sessionToken` + `preferredLocale` + pending-onboarding-context (`pendingCuisine`, `pendingRestaurantName`, `pendingCurrency`) + **`stripeCustomerId`** (per-human Stripe customer; one customer owns many per-restaurant subscriptions) + email-campaign tracking (`emailsSent`, `emailUnsubscribed`, `upsellShownAt`, `reminderSentAt`). |
| `Session` | Multi-session table — `tokenHash` unique, `userAgent`, `ip`, `expiresAt`. |
| `Restaurant` | Branding, currency, contacts, timezone, languages, reservation + order configuration, AI quotas, checklist flags **AND per-restaurant billing fields**: `plan` (FREE/BASIC/PRO), `billingCycle` (MONTHLY/YEARLY), `subscriptionStatus`, `currentPeriodEnd`, `paymentProcessing`, `stripeSubscriptionId` (unique), `trialEndsAt`. Trial is populated only for the user's first restaurant; subsequent restaurants start FREE without trial. |
| `RestaurantUser` | Flat user ↔ restaurant attachment. `addedBy` is null for the original creator (owner), non-null for users attached later (managers). `viaGrant` in `AuthGuard` is derived from `addedBy !== null`. Replaces the old UserCompany + RestaurantAccess split. |
| `Table` | number, capacity, zone, color, x/y on floor map, photo. Soft-delete via `deletedAt`. |
| `Reservation` | date + startTime + duration (minutes), status, guest details. |
| `Category` | 2-level tree via `parentId` (group → categories). Soft-delete. |
| `Item` | dishes; allergens + diets arrays; options JSON (variant groups with priceDelta); soft-delete. `categoryId` is nullable + SetNull so deleting a category orphans the item instead of cascade-removing — orders + historical analytics keep resolving. |
| `PageView` | analytics rows from public-menu-api `/analytics/track`. Keyed by `restaurantId`. |
| `SupportMessage` | per-restaurant support chat. `restaurantId` is NOT NULL — old rows were backfilled in migration B from the company's first restaurant. |
| `UsageEvent` | unified analytics events (replaces old PulseEvent + Session + AnalyticsEvent). gclid/ad_params + `userId` + `restaurantId` attached server-side. `is_google_ads` / `is_facebook_ads` / `is_search` flags; `fbSentEvents` records which Meta CAPI events were already pushed for dedup. |
| `Order` | items JSON + per-order discount + discountTotal; `statusBeforeClose` so "Return to kitchen" restores the prior status; soft-delete. Unique on `(restaurantId, orderDate, dailyNumber)`. |
| `Device` | tablet pairing record — name, type (`KITCHEN`/`WAITER`/`RESERVATION`), status, `tokenVersion` (bumped on revoke; re-checked in DeviceGuard), heartbeat (`lastSeenAt`). **⚠ Missing `restaurant Restaurant @relation onDelete: Cascade` — see audit CRIT-2: deleting a restaurant currently leaves orphan devices.** |
| `PairingCode` | one-time 6-digit code for a Device. TTL ~120s. Replaced on regenerate. |

**Removed in Stage C (2026-05-28):** `Company`, `UserCompany`, `RestaurantAccess`, `GoogleAdsExclusion`, plus every `companyId` column on the surviving tables.

## Cross-service contract

- **Real-time** — channel `orders_events` (and `orders_events_heartbeat`). Publishers: public-menu-api (order/booking created) and this service (status changes, revokes, force-reload). Subscriber: this service's `OrdersEventsService` → fans to `/orders/stream` (admin) and `/devices/stream` (tablets).
- **Shared cookies** on `*.iq-rest.com`: `iqr_session`, `iqr_email`, legacy `session`, `user_email`, `iqr_active_restaurant_id`, `iqr_admin_original_*`. Setting `COOKIE_DOMAIN=.iq-rest.com` in prod makes everything interop with the legacy monolith and the public menu.
- **App version header** — `X-App-Version` on every response. The dashboard reads it and reloads on a route change when it changes.

## Deployment

GitHub Actions builds on push → uploads to `/home/deploy/apps/iq-rest-dashboard-api/` → PM2 process `dashboard-api` runs `node dist/src/main.js` on port 8130. Nginx fronts `dashboard-api.iq-rest.com`.

## Conventions

- Validation via `class-validator` DTOs (most modules) + `zod` in a couple of spots (orders/reservations/usage/analytics-track).
- Soft-delete everywhere a record might be referenced from `Order.items` snapshots: `Restaurant`, `Table`, `Category`, `Item`, `Order`.
- Money is `Decimal(10,2)` — always wrap in `Number()` when returning to clients.
- Background side effects (emails, NOTIFYs) must `void` / `.catch(...)` and never block the user.
- SSRF guards: any user-supplied URL that we fetch must be checked against `${S3_HOST}/${S3_NAME}/` (see `items.generateImage`).
- Cookies: HttpOnly for tokens, non-HttpOnly for the email mirror cookie the UI needs to read.
- Per-restaurant billing — every billing decision keys on the **active restaurant** (`req.authUser.restaurantId`). `viaGrant` users (managers) are 403'd on checkout/portal/delete; the owner of each restaurant is the user with `RestaurantUser.addedBy === null`.
- Throttling: per-route `@Throttle` overrides where the default 600/60s is too generous (e.g. `/track/:event`).

## Related repositories

- `iq-rest-dashboard-web` — Vite/React dashboard SPA + KDS / waiter / reservation kiosk apps (consumes this API)
- `iq-rest-public-menu-api` — sibling backend serving the guest menu; publisher on the same `orders_events` channel
- `iq-rest-public-menu` — guest-facing PWA
- `iq-rest-landing` — marketing landing (legacy; **not maintained**), posts tracking events to `POST /api/track/:event`

## Scripts (`scripts/`)

One-off Node/SQL scripts. Run with `npx ts-node scripts/<name>.ts`.

- `backfill-restaurant-timezone.ts` — derives `Restaurant.timezone` from stored lat/lon (x, y).
- `fb-capi-test.ts` — sanity-test Meta CAPI integration.
- `fix-order-snapshots-by-email.ts` — repair item snapshots in `Order.items` JSON.
- `generate-preset-thumbs.ts` / `generate-template-images.ts` / `optimize-template-images.ts` — onboarding cuisine-template image generation/optimization (sharp).
- `migrate-to-usage-events.sql` — historical migration to the unified `usage_events` table.
- `translate-emails.ts` — bulk-translate the email template strings.
