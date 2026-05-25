// One-off test: send Meta Conversions API (CAPI) events to verify the pixel +
// token work before wiring real conversions into the app.
//
// Sends to the TEST stream (test_event_code) so nothing pollutes real
// optimization data. Watch them arrive in Events Manager → your pixel →
// Test Events tab.
//
// Reads FB_ADS_TOKEN + FB_ADS_PIXEL_ID from env (.env auto-loaded).
//
// Usage:
//   npx tsx scripts/fb-capi-test.ts                 # synthetic fbclid
//   npx tsx scripts/fb-capi-test.ts <fbclid>        # real fbclid from a l_fbclid_* event
//   FB_TEST_EVENT_CODE=TEST15259 npx tsx scripts/fb-capi-test.ts
//
// fbc format: fb.<subdomainIndex>.<clickTimeMs>.<fbclid>  (index 1 = root domain)

import "dotenv/config";

const GRAPH_VERSION = "v21.0";
const TEST_EVENT_CODE = process.env.FB_TEST_EVENT_CODE ?? "TEST15259";

async function main() {
  const token = process.env.FB_ADS_TOKEN;
  const pixelId = process.env.FB_ADS_PIXEL_ID;
  if (!token) throw new Error("FB_ADS_TOKEN not set");
  if (!pixelId) throw new Error("FB_ADS_PIXEL_ID not set");

  const fbclid = process.argv[2] ?? `TEST_${Date.now()}_synthetic`;
  const nowSec = Math.floor(Date.now() / 1000);
  const fbc = `fb.1.${Date.now()}.${fbclid}`;

  // Shared user_data. With a real visitor we'd also pass client_ip_address +
  // client_user_agent (improves match quality). For a format test, fbc alone
  // is a valid match key.
  const userData = {
    fbc,
    client_user_agent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  };

  // Two events: top-of-funnel PageView (learning signal) + the actual
  // CompleteRegistration conversion.
  const events = [
    {
      event_name: "PageView",
      event_time: nowSec,
      action_source: "website",
      event_source_url: "https://soqrmenu.com/",
      user_data: userData,
    },
    {
      event_name: "CompleteRegistration",
      event_time: nowSec,
      action_source: "website",
      event_source_url: "https://soqrmenu.com/",
      user_data: userData,
    },
  ];

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${token}`;
  const body = { data: events, test_event_code: TEST_EVENT_CODE };

  console.log("→ pixel:", pixelId);
  console.log("→ fbclid:", fbclid);
  console.log("→ fbc:", fbc);
  console.log("→ test_event_code:", TEST_EVENT_CODE);
  console.log("→ events:", events.map((e) => e.event_name).join(", "));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();

  console.log("\n← status:", res.status);
  console.log("← body:", JSON.stringify(json, null, 2));

  if (!res.ok) {
    console.error("\n✗ FAILED — check token scope / pixel id above");
    process.exit(1);
  }
  console.log(
    "\n✓ accepted. Open Events Manager → Test Events tab to confirm they show up.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
