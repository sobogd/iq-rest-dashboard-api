import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "../i18n/i18n.service";

interface SendOtpOptions {
  email: string;
  code: string;
  locale: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  async sendOtp({ email, code, locale }: SendOtpOptions): Promise<void> {
    const host = this.config.get<string>("SMTP_HOST");
    const port = Number(this.config.get<string>("SMTP_PORT") || 587);
    const user = this.config.get<string>("SMTP_USER");
    const pass = this.config.get<string>("SMTP_PASS");
    const from = this.config.get<string>("FROM_EMAIL") || user;

    if (!host || !user || !pass || !from) {
      this.logger.warn(`SMTP not configured — skipping OTP send. code=${code} email=${email}`);
      return;
    }

    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    const t = this.i18n.bundle(locale).otpEmail;
    const subject = t.subject.replace("{code}", code);
    const dir = this.i18n.isRtl(locale) ? "rtl" : "ltr";

    await transporter.sendMail({
      from,
      to: email,
      subject,
      html: `
        <div dir="${dir}" style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
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

  async sendSupportReplyNotification(toEmail: string, locale = "en"): Promise<void> {
    const host = this.config.get<string>("SMTP_HOST");
    const port = Number(this.config.get<string>("SMTP_PORT") || 587);
    const user = this.config.get<string>("SMTP_USER");
    const pass = this.config.get<string>("SMTP_PASS");
    const from = this.config.get<string>("FROM_EMAIL") || user;
    if (!host || !user || !pass || !from) {
      this.logger.warn(`SMTP not configured — skip support notification for ${toEmail}`);
      return;
    }

    const t = this.i18n.bundle(locale).supportEmail;
    const dir = this.i18n.isRtl(locale) ? "rtl" : "ltr";
    const ctaUrl = (process.env.APP_URL || "https://dashboard.iq-rest.com").replace(/\/$/, "") +
      `/${this.i18n.urlLocale(locale)}/dashboard/settings/support`;

    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    await transporter.sendMail({
      from,
      to: toEmail,
      subject: t.subject,
      html: `
        <div dir="${dir}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
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
