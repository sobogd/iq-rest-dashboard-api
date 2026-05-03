import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Transporter } from "nodemailer";
import { I18nService } from "../i18n/i18n.service";
import { pickWelcomePersonal, isRtl as isWelcomeRtl } from "./templates/welcome-personal";

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

  /** Personal welcome email — manually triggered from admin panel.
   *  Locale picks the matching translation (falls back to English).
   *  `name` substitutes {name} in subject + greeting (restaurant title or
   *  email local-part).
   */
  async sendWelcomePersonal({
    email,
    name,
    locale,
  }: {
    email: string;
    name: string;
    locale: string;
  }): Promise<void> {
    const cfg = this.smtpConfig();
    if (!cfg) {
      this.logger.warn("SMTP not configured — welcome_personal skipped");
      return;
    }
    const transporter = await this.getTransporter(cfg);
    const t = pickWelcomePersonal(locale);
    const subject = t.subject.replace("{name}", name);
    const greeting = t.greeting.replace("{name}", name);
    const dir = isWelcomeRtl(locale) ? "rtl" : "ltr";

    await transporter.sendMail({
      from: this.cachedFrom ?? cfg.from,
      to: email,
      subject,
      html: `
        <div dir="${dir}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          ${this.logoMark()}
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${greeting}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${t.body}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${t.help}</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 20px">${t.closing}</p>
          <p style="font-size:15px;margin:0;color:#1a1a1a">${t.signature}</p>
        </div>
      `,
      text: `${greeting}\n\n${t.body}\n\n${t.help}\n\n${t.closing}\n\n${t.signature.replace(/<br>/g, "\n")}`,
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
    const ctaUrl = `${appUrl}/${this.i18n.urlLocale(locale)}/dashboard/settings/support`;

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
