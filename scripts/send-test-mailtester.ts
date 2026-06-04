// One-off: send the EN setup-incomplete reminder to a mail-tester.com inbox to
// check the spam score. Reuses the real template + the exact HTML/text/header
// shape from MailService.sendMenuAlmostReady. SMTP creds are read from
// soqrmenuweb/.env (the shared source of truth) — nothing is printed.
//
// Run: npx ts-node scripts/send-test-mailtester.ts <to-address>

import { readFileSync } from "fs";
import { resolve } from "path";
import nodemailer from "nodemailer";
import { pickMenuAlmostReady, isRtl } from "../src/mail/templates/menu-almost-ready";

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

function logoMark(): string {
  return `<div style="text-align:center;margin:0 0 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;font-size:32px;font-weight:900;letter-spacing:-1px;line-height:1"><span style="color:#1a1a1a">IQ </span><span style="color:#FF6229">Rest</span></div>`;
}

async function main() {
  const to = process.argv[2];
  if (!to) throw new Error("usage: ts-node scripts/send-test-mailtester.ts <to-address>");

  const env = loadEnv(resolve(__dirname, "../../soqrmenuweb/.env"));
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT || 587);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const from = env.FROM_EMAIL || user;
  if (!host || !user || !pass || !from) throw new Error("SMTP creds missing in soqrmenuweb/.env");

  const locale = "en";
  const t = pickMenuAlmostReady(locale);
  const subject = t.subject;
  const greeting = t.greeting;
  const dir = isRtl(locale) ? "rtl" : "ltr";
  const dashUrl = "https://dashboard.iq-rest.com";

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    headers: { "List-Unsubscribe": "<mailto:support@iq-rest.com?subject=unsubscribe>" },
    html: `
        <div dir="${dir}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          ${logoMark()}
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${greeting}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 24px">${t.body}</p>
          <p style="margin:0 0 24px"><a href="${dashUrl}" style="display:inline-block;background:#FF6229;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:12px 24px;border-radius:8px">${t.cta}</a></p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${t.help}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${t.closing}</p>
          <p style="font-size:15px;margin:0;color:#1a1a1a">${t.signature}</p>
        </div>
      `,
    text: `${greeting}\n\n${t.body}\n\n${t.cta}: ${dashUrl}\n\n${t.help}\n\n${t.closing}\n\n${t.signature.replace(/<br>/g, "\n")}`,
  });

  console.log("sent:", info.messageId, "->", to);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
