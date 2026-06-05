// AI session analysis for the admin "Sessions" screen. Takes one usage
// session (the chronological list of tracked events for a restaurant/anon
// visitor) and asks Gemini to explain the human behind it: who they are, what
// they engaged with, where they got stuck, and why they likely dropped off.
//
// The event names are intentionally NOT enumerated one-by-one (there are 300+).
// Instead we hand the model the NAMING CONVENTION (prefixes + area/action
// tokens + funnel description) so it can decode any `l_*` / `dash_*` event it
// sees. That "mapping" + the product context below is the whole point — it
// turns opaque event strings into a behavioural narrative.

export interface AnalyzeEvent {
  at: string; // ISO
  event: string;
  device: string | null;
  platform: string | null;
  country: string | null;
  region: string | null;
}

export interface AnalyzeContext {
  country: string;
  region: string | null;
  userLabel: string | null; // email if identified
  restaurantLabel: string | null;
  eventCount: number; // true total (may exceed the listed events)
  hasGoogle: boolean;
  hasFacebook: boolean;
}

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ── Product + event-vocabulary the model needs to read the transcript ──

const SYSTEM_PROMPT = `You are a senior product analyst for IQ Rest (brand also seen as "SoqrMenu"), a SaaS for restaurants.

PRODUCT
IQ Rest lets restaurant owners build a digital QR menu, take in-house orders, run a kitchen display (KDS), and accept table reservations. Core value = digital menu + kitchen display + reservations; online ordering is secondary.
Two surfaces emit analytics events:
- The marketing landing (iq-rest.com): anonymous visitors discovering the product, reading feature pages, and signing up.
- The dashboard (dashboard.iq-rest.com): the logged-in owner managing their restaurant.

A "session" below is all tracked events grouped for ONE visitor/restaurant over a 30-day window (identified users grouped by restaurant; anonymous visitors grouped by IP/region). It can mix landing + dashboard activity if the visitor signed up.

EVENT NAMING CONVENTION (decode every event with this)
Prefixes:
- l_*    = marketing LANDING event (anonymous discovery / signup funnel).
- dash_* = logged-in DASHBOARD event (owner using the product).
- l_gclid_<id> / l_fbclid_<id> = a PAID AD click landed (Google / Meta). Presence means this visitor came from paid advertising.

Landing (l_) tokens:
- l_page_<feature> = viewed a page. Feature tokens: home, pricing, help, digital (digital menu), qr (QR menu), orders (ordering system), bookings (table reservations), kds (kitchen display).
- l_hero_* = interacted with the homepage hero (e.g. main CTA, demo button).
- l_demo_* = opened/used the interactive product demo embedded on the landing.
- l_pricing_* = pricing page interactions (plan clicks, CTA).
- l_feature_* = feature-page interactions.
- l_header_* / l_footer_* = top/bottom navigation (signin, dashboard, language, help, legal links).
- l_onb_* = the SIGNUP / onboarding funnel (the make-or-break conversion flow). Sub-steps:
    l_onb_name_* (restaurant name step), l_onb_cuisine_* (cuisine pick),
    l_onb_google_click / l_onb_apple_click (social sign-in), l_onb_email_submit / l_onb_email_invalid,
    l_onb_otp_sent / l_onb_verify_submit / l_onb_verify_success (email OTP verification),
    l_onb_resend_click, l_onb_change_email_click, l_onb_open_terms / l_onb_open_privacy.
  l_onb_verify_success ≈ account created. Reaching l_onb_email_submit / otp but NOT verify_success = signup abandoned mid-flow (a hot but lost lead).

Dashboard (dash_) tokens follow dash_<area>_<action>:
- areas: menu, category, item, orders, booking, settings (with sub-areas: about/contacts/branding/general/orders/booking/langs/billing/support/tables), onboarding (first-run menu setup), scan (paper-menu photo OCR import), analytics, trial_banner, scan_banner.
- actions: click_*, focus_* (focused an input — intent to fill), save / save_error, back, add_*, delete, toggle_*, etc.
- Notable: dash_onboarding_* = first-run guided menu setup (start/continue/skip/done). dash_scan_* = importing a paper menu via photo OCR. dash_settings_billing_* = touched billing/upgrade. *_save_error / dash_error_fetch = the user hit an ERROR (friction signal). focus_* without a following save = started but didn't finish.

HOW TO READ DROP-OFF
- Short session, only l_page_home or one feature page, then nothing = likely a bounce / random/low-intent visitor (especially if arrived via paid ad and left fast).
- Deep landing exploration (multiple feature pages, demo, pricing) then no signup = interested but not convinced; note WHAT they kept looking at.
- Signup funnel entered but no l_onb_verify_success = lost at signup; identify the last step reached.
- Dashboard session that stalls after repeated focus_* / save_error on the same area = a usability blocker there.
- Repeated views of one area = what they care about most.

OUTPUT (write in RUSSIAN, plain text, no markdown tables, no code fences). Use these sections with short paragraphs / dashes:
1. Кто это — тип пользователя (случайный залётный / заинтересованный лид / зарегистрировавшийся владелец / активный клиент), источник трафика (платная реклама?), устройство/страна.
2. Что делал — краткая хронология ключевых шагов и на что смотрел чаще всего.
3. Где затык / почему отвалился — конкретный момент и вероятная причина (ошибки, брошенный шаг воронки, потеря интереса).
4. Рекомендации — 2-4 конкретных действия по продукту/воронке, которые могли бы удержать таких пользователей.
Be concrete and reference the actual events/steps. If the session is too thin to judge, say so plainly. Keep it under ~350 words.`;

/** Compact chronological transcript with relative timestamps. */
function buildTranscript(events: AnalyzeEvent[]): string {
  if (events.length === 0) return "(no events)";
  // Events arrive newest-first from the query; replay oldest-first.
  const asc = [...events].sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const t0 = +new Date(asc[0].at);
  // Bound the prompt: keep the head and tail of very long sessions.
  const MAX = 600;
  if (asc.length > MAX) {
    const head = asc.slice(0, MAX / 2).map((e) => fmt(e, t0));
    const tail = asc.slice(asc.length - MAX / 2).map((e) => fmt(e, t0));
    return `${head.join("\n")}\n… (${asc.length - MAX} events omitted) …\n${tail.join("\n")}`;
  }
  return asc.map((e) => fmt(e, t0)).join("\n");
}

function fmt(e: AnalyzeEvent, t0: number): string {
  const secs = Math.max(0, Math.round((+new Date(e.at) - t0) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `[+${mm}:${ss}] ${e.event}`;
}

function buildUserMessage(events: AnalyzeEvent[], ctx: AnalyzeContext): string {
  const dev = events.find((e) => e.device || e.platform);
  const device = dev ? [dev.platform, dev.device].filter(Boolean).join(" / ") : "unknown";
  const meta = [
    `Identified user: ${ctx.userLabel ?? "anonymous"}`,
    `Restaurant: ${ctx.restaurantLabel ?? "—"}`,
    `Country/region: ${ctx.country || "??"}${ctx.region ? " / " + ctx.region : ""}`,
    `Device: ${device}`,
    `Arrived via paid ads: Google=${ctx.hasGoogle ? "yes" : "no"}, Meta=${ctx.hasFacebook ? "yes" : "no"}`,
    `Total events in session: ${ctx.eventCount}`,
  ].join("\n");
  return `SESSION META\n${meta}\n\nEVENT TRANSCRIPT (relative time, oldest first)\n${buildTranscript(events)}`;
}

/** Run the analysis. Returns Gemini's Russian narrative. */
export async function analyzeSession(
  events: AnalyzeEvent[],
  ctx: AnalyzeContext,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: buildUserMessage(events, ctx) }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1400 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini returned no text");
  return text;
}
