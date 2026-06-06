import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Transporter } from "nodemailer";
import { I18nService } from "../i18n/i18n.service";
import { pickWelcomePersonal, isRtl as isWelcomeRtl } from "./templates/welcome-personal";
import { pickMenuAlmostReady, isRtl as isMarRtl } from "./templates/menu-almost-ready";
import { pickTrialEnding, isRtl as isTrialEndingRtl } from "./templates/trial-ending";
import { pickReservationStatus, isRtl as isResRtl } from "./templates/reservation-status";

interface SendOtpOptions {
  email: string;
  code: string;
  locale: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private transporterPromise: Promise<Transporter> | null = null;
  private cachedFrom: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  onModuleDestroy(): void {
    if (!this.transporterPromise) return;
    void this.transporterPromise.then((t) => t.close()).catch(() => undefined);
  }

  private smtpConfig(): SmtpConfig | null {
    const host = this.config.get<string>("SMTP_HOST");
    const port = Number(this.config.get<string>("SMTP_PORT") || 587);
    const user = this.config.get<string>("SMTP_USER");
    const pass = this.config.get<string>("SMTP_PASS");
    const from = this.config.get<string>("FROM_EMAIL") || user;
    if (!host || !user || !pass || !from) return null;
    return { host, port, user, pass, from };
  }

  /** Lazily build a pooled transporter once. Reused for every send. */
  private async getTransporter(cfg: SmtpConfig): Promise<Transporter> {
    if (this.transporterPromise) return this.transporterPromise;
    this.transporterPromise = (async () => {
      const nodemailer = (await import("nodemailer")).default;
      const t = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.port === 465,
        auth: { user: cfg.user, pass: cfg.pass },
        pool: true,
        maxConnections: 5,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
      this.cachedFrom = cfg.from;
      return t;
    })();
    return this.transporterPromise;
  }

  /** Inline text-mark logo for email headers. Light-bg variant: dark "IQ"
   *  + primary orange "Rest", Inter-fallback bold. RTL-flip handled by parent dir. */
  private logoMark(): string {
    return `<div style="text-align:center;margin:0 0 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;font-size:32px;font-weight:900;letter-spacing:-1px;line-height:1"><span style="color:#1a1a1a">IQ </span><span style="color:#FF6229">Rest</span></div>`;
  }

  async sendOtp({ email, code, locale }: SendOtpOptions): Promise<void> {
    const cfg = this.smtpConfig();
    if (!cfg) {
      // Never log the code or recipient address — these are PII / auth secrets.
      this.logger.warn("SMTP not configured — OTP email skipped");
      return;
    }

    const transporter = await this.getTransporter(cfg);
    const t = this.i18n.bundle(locale).otpEmail;
    const subject = t.subject.replace("{code}", code);
    const dir = this.i18n.isRtl(locale) ? "rtl" : "ltr";

    await transporter.sendMail({
      from: this.cachedFrom ?? cfg.from,
      to: email,
      subject,
      html: `
        <div dir="${dir}" style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          ${this.logoMark()}
          <p>${t.greeting}</p>
          <p>${t.intro}</p>
          <div style="margin:24px 0;padding:24px;background:#f5f5f5;border-radius:12px;text-align:center">
            <span style="font-size:36px;font-weight:bold;letter-spacing:8px">${code}</span>
          </div>
          <p style="font-size:13px;color:#666">${t.expiry}</p>
        </div>
      `,
      text: `${t.greeting}\n\n${t.intro}\n\n${code}\n\n${t.expiry}`,
    });
  }

  /** Shared renderer for the personal "Bogdan" emails (welcome,
   *  setup-incomplete, trial-ending). Builds the HTML + text, an optional CTA
   *  button and the List-Unsubscribe header, then sends. Name-less by design —
   *  many owners never set a restaurant title. */
  private async sendPersonalEmail(opts: {
    kind: string;
    email: string;
    subject: string;
    dir: "rtl" | "ltr";
    greeting: string;
    body: string;
    help: string;
    closing: string;
    signature: string;
    cta?: string;
    ctaUrl?: string;
  }): Promise<void> {
    const cfg = this.smtpConfig();
    if (!cfg) {
      this.logger.warn(`SMTP not configured — ${opts.kind} skipped`);
      return;
    }
    const transporter = await this.getTransporter(cfg);
    const hasCta = Boolean(opts.cta && opts.ctaUrl);
    const button = hasCta
      ? `<p style="margin:0 0 24px"><a href="${opts.ctaUrl}" style="display:inline-block;background:#FF6229;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:12px 24px;border-radius:8px">${opts.cta}</a></p>`
      : "";
    const buttonText = hasCta ? `${opts.cta}: ${opts.ctaUrl}\n\n` : "";

    await transporter.sendMail({
      from: this.cachedFrom ?? cfg.from,
      to: opts.email,
      subject: opts.subject,
      // List-Unsubscribe lets Gmail/Apple Mail render a native "Unsubscribe"
      // action; mailto variant needs no endpoint — replies land in support.
      headers: { "List-Unsubscribe": "<mailto:support@iq-rest.com?subject=unsubscribe>" },
      html: `
        <div dir="${opts.dir}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          ${this.logoMark()}
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${opts.greeting}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 ${hasCta ? "24px" : "20px"}">${opts.body}</p>
          ${button}
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${opts.help}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${opts.closing}</p>
          <p style="font-size:15px;margin:0;color:#1a1a1a">${opts.signature}</p>
        </div>
      `,
      text: `${opts.greeting}\n\n${opts.body}\n\n${buttonText}${opts.help}\n\n${opts.closing}\n\n${opts.signature.replace(/<br>/g, "\n")}`,
    });
  }

  private dashboardUrl(): string {
    return this.config.get<string>("DASHBOARD_URL") || "https://dashboard.iq-rest.com";
  }

  /** Personal welcome email — manually triggered from the admin panel.
   *  Name-less; CTA opens the dashboard. */
  async sendWelcomePersonal({ email, locale }: { email: string; locale: string }): Promise<void> {
    const t = pickWelcomePersonal(locale);
    await this.sendPersonalEmail({
      kind: "welcome_personal",
      email,
      subject: t.subject,
      dir: isWelcomeRtl(locale) ? "rtl" : "ltr",
      greeting: t.greeting,
      body: t.body,
      help: t.help,
      closing: t.closing,
      signature: t.signature,
      cta: t.cta,
      ctaUrl: this.dashboardUrl(),
    });
  }

  /** Setup-incomplete reminder — owners who started but didn't finish setup.
   *  Name-less; CTA opens the dashboard. */
  async sendMenuAlmostReady({ email, locale }: { email: string; locale: string }): Promise<void> {
    const t = pickMenuAlmostReady(locale);
    await this.sendPersonalEmail({
      kind: "menu_almost_ready",
      email,
      subject: t.subject,
      dir: isMarRtl(locale) ? "rtl" : "ltr",
      greeting: t.greeting,
      body: t.body,
      help: t.help,
      closing: t.closing,
      signature: t.signature,
      cta: t.cta,
      ctaUrl: this.dashboardUrl(),
    });
  }

  /** Trial-ending reminder — sent 1 day before trial expiry. Name-less; CTA
   *  opens the billing page. */
  async sendTrialEnding({ email, locale }: { email: string; locale: string }): Promise<void> {
    const t = pickTrialEnding(locale);
    await this.sendPersonalEmail({
      kind: "trial_ending",
      email,
      subject: t.subject,
      dir: isTrialEndingRtl(locale) ? "rtl" : "ltr",
      greeting: t.greeting,
      body: t.body,
      help: t.help,
      closing: t.closing,
      signature: t.signature,
      cta: t.cta,
      ctaUrl: `${this.dashboardUrl()}/settings/billing`,
    });
  }

  /** Reservation confirmed/cancelled email to the guest. Skipped silently if
   *  SMTP isn't configured — caller should fire-and-forget via .catch(). */
  async sendReservationStatus({
    email,
    guestName,
    restaurantTitle,
    date,
    startTime,
    guestsCount,
    tableNumber,
    status,
    locale,
  }: {
    email: string;
    guestName: string;
    restaurantTitle: string;
    date: string;
    startTime: string;
    guestsCount: number;
    tableNumber: number | null;
    status: "confirmed" | "cancelled";
    locale: string;
  }): Promise<void> {
    const cfg = this.smtpConfig();
    if (!cfg) {
      this.logger.warn("SMTP not configured — reservation status email skipped");
      return;
    }
    const transporter = await this.getTransporter(cfg);
    const t = pickReservationStatus(locale);
    const sub = (status === "confirmed" ? t.subjectConfirmed : t.subjectCancelled).replace("{restaurant}", restaurantTitle);
    const greeting = t.greeting.replace("{name}", guestName);
    const body = (status === "confirmed" ? t.bodyConfirmed : t.bodyCancelled).replace("{restaurant}", restaurantTitle);
    const outro = status === "confirmed" ? t.outroConfirmed : t.outroCancelled;
    const sig = t.signature.replace("{restaurant}", restaurantTitle);
    const dir = isResRtl(locale) ? "rtl" : "ltr";

    const row = (label: string, value: string) =>
      `<tr><td style="padding:8px 12px;font-size:15px;color:#666;white-space:nowrap;">${label}</td><td style="padding:8px 12px;font-size:15px;font-weight:600;color:#1a1a1a;">${value}</td></tr>`;
    let rows = "";
    rows += row(t.dateLabel, date);
    rows += row(t.timeLabel, startTime);
    rows += row(t.guestsLabel, String(guestsCount));
    if (tableNumber !== null && tableNumber !== undefined) rows += row(t.tableLabel, String(tableNumber));

    await transporter.sendMail({
      from: this.cachedFrom ?? cfg.from,
      to: email,
      subject: sub,
      html: `
        <div dir="${dir}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          ${this.logoMark()}
          <p style="font-size:20px;font-weight:600;line-height:1.5;margin:0 0 20px">${greeting}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${body}</p>
          <p style="font-size:15px;font-weight:600;margin:0 0 8px">${t.detailsLabel}</p>
          <table style="border-collapse:collapse;margin:0 0 24px;background:#f5f5f5;border-radius:12px;overflow:hidden;width:100%">${rows}</table>
          <p style="font-size:15px;line-height:1.7;margin:0 0 24px;color:#666">${outro}</p>
          <p style="font-size:15px;margin:0;color:#1a1a1a">${sig}</p>
        </div>
      `,
      text: `${greeting}\n\n${body}\n\n${t.detailsLabel}\n${t.dateLabel}: ${date}\n${t.timeLabel}: ${startTime}\n${t.guestsLabel}: ${guestsCount}${tableNumber !== null && tableNumber !== undefined ? `\n${t.tableLabel}: ${tableNumber}` : ""}\n\n${outro}\n\n${sig}`,
    });
  }

  /** Notify the IQ Rest support inbox when a customer sends a new
   *  support message. Fire-and-forget from the support controller so
   *  SMTP failures don't bubble back to the writer. Recipient address
   *  comes from SUPPORT_INBOX_EMAIL (falls back to support@iq-rest.com).
   */
  async sendAdminSupportNewMessageNotification({
    companyName,
    userEmail,
    message,
  }: {
    companyName: string;
    userEmail: string;
    message: string;
  }): Promise<void> {
    const cfg = this.smtpConfig();
    if (!cfg) {
      this.logger.warn("SMTP not configured — admin support notification skipped");
      return;
    }
    const transporter = await this.getTransporter(cfg);
    const to =
      this.config.get<string>("SUPPORT_INBOX_EMAIL") || "support@iq-rest.com";
    const appUrl = (this.config.get<string>("APP_URL") || "https://dashboard.iq-rest.com").replace(/\/$/, "");
    const adminUrl = `${appUrl}/en/dashboard/admin?from=email`;
    const safeMessage = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const subject = `[IQ Rest support] ${companyName} — new message`;

    await transporter.sendMail({
      from: this.cachedFrom ?? cfg.from,
      to,
      subject,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          ${this.logoMark()}
          <p style="font-size:15px;line-height:1.6;margin:0 0 8px;color:#666">From <strong>${userEmail}</strong> at <strong>${companyName}</strong></p>
          <div style="margin:20px 0;padding:20px;background:#f5f5f5;border-radius:12px;font-size:15px;line-height:1.6;white-space:pre-wrap">${safeMessage}</div>
          <p style="font-size:15px;line-height:1.7;margin:24px 0 0">
            <a href="${adminUrl}" style="color:#0066cc">Open admin dashboard</a>
          </p>
        </div>
      `,
      text: `New support message from ${userEmail} at ${companyName}:\n\n${message}\n\nAdmin: ${adminUrl}`,
    });
  }

  /** Half-hourly reminder that the unified admin inbox has unread threads.
   *  Recipient comes from SUPPORT_INBOX_EMAIL (falls back to support@iq-rest.com). */
  async sendAdminUnreadInboxNotification(count: number): Promise<void> {
    const cfg = this.smtpConfig();
    if (!cfg) {
      this.logger.warn("SMTP not configured — unread inbox notification skipped");
      return;
    }
    const transporter = await this.getTransporter(cfg);
    const to =
      this.config.get<string>("SUPPORT_INBOX_EMAIL") || "support@iq-rest.com";
    const appUrl = (this.config.get<string>("APP_URL") || "https://dashboard.iq-rest.com").replace(/\/$/, "");
    const inboxUrl = `${appUrl}/en/dashboard/settings/admin/inbox?from=email`;
    const label = count === 1 ? "1 unread conversation" : `${count} unread conversations`;
    const subject = `[IQ Rest inbox] ${label}`;

    await transporter.sendMail({
      from: this.cachedFrom ?? cfg.from,
      to,
      subject,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          ${this.logoMark()}
          <p style="font-size:15px;line-height:1.6;margin:0 0 8px">You have <strong>${label}</strong> waiting in the admin inbox.</p>
          <p style="font-size:15px;line-height:1.7;margin:24px 0 0">
            <a href="${inboxUrl}" style="color:#0066cc">Open inbox</a>
          </p>
        </div>
      `,
      text: `You have ${label} waiting in the admin inbox.\n\nInbox: ${inboxUrl}`,
    });
  }

  async sendSupportReplyNotification(toEmail: string, locale = "en"): Promise<void> {
    const cfg = this.smtpConfig();
    if (!cfg) {
      this.logger.warn("SMTP not configured — support notification skipped");
      return;
    }

    const transporter = await this.getTransporter(cfg);
    const t = this.i18n.bundle(locale).supportEmail;
    const dir = this.i18n.isRtl(locale) ? "rtl" : "ltr";
    const appUrl = (this.config.get<string>("APP_URL") || "https://dashboard.iq-rest.com").replace(/\/$/, "");
    const ctaUrl = `${appUrl}/${this.i18n.urlLocale(locale)}/dashboard/settings/support?from=email`;

    await transporter.sendMail({
      from: this.cachedFrom ?? cfg.from,
      to: toEmail,
      subject: t.subject,
      html: `
        <div dir="${dir}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          ${this.logoMark()}
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${t.greeting}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${t.body}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">
            <a href="${ctaUrl}" style="color:#0066cc">${t.cta}</a>
          </p>
          <p style="font-size:15px;margin:20px 0 0;color:#1a1a1a">${t.signature}</p>
        </div>
      `,
      text: `${t.greeting}\n\n${t.body}\n\n${t.cta}: ${ctaUrl}\n\n${t.signature.replace(/<br\s*\/?>/g, "\n")}`,
    });
  }
}
