import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface SendOtpOptions {
  email: string;
  code: string;
  locale: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

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

    // Lazy import to keep boot light when SMTP isn't configured locally.
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    const subject = locale === "es" ? `Tu código: ${code}` : `Your code: ${code}`;
    const greeting = locale === "es" ? "Hola," : "Hi,";
    const intro = locale === "es"
      ? "Usa este código para iniciar sesión en IQ Rest."
      : "Use this code to sign in to IQ Rest.";
    const expiry = locale === "es"
      ? "Caduca en 5 minutos."
      : "Expires in 5 minutes.";

    await transporter.sendMail({
      from,
      to: email,
      subject,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
          <p>${greeting}</p>
          <p>${intro}</p>
          <div style="margin:24px 0;padding:24px;background:#f5f5f5;border-radius:12px;text-align:center">
            <span style="font-size:36px;font-weight:bold;letter-spacing:8px">${code}</span>
          </div>
          <p style="font-size:13px;color:#666">${expiry}</p>
        </div>
      `,
      text: `${greeting}\n\n${intro}\n\n${code}\n\n${expiry}`,
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

    const t = SUPPORT_EMAIL[locale] || SUPPORT_EMAIL.en;
    const ctaUrl = (process.env.APP_URL || "https://dashboard.iq-rest.com").replace(/\/$/, "") +
      `/${locale === "es" ? "es" : "en"}/dashboard/settings/support`;

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
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1a1a1a">
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

const SUPPORT_EMAIL: Record<string, {
  subject: string;
  greeting: string;
  body: string;
  cta: string;
  signature: string;
}> = {
  en: {
    subject: "You have a new message from IQ Rest Support",
    greeting: "Hey!",
    body: "You have a new message from our support team. Please check your dashboard to view it.",
    cta: "Open Support Chat",
    signature: "Cheers,<br>The IQ Rest Team",
  },
  es: {
    subject: "Tienes un nuevo mensaje del soporte de IQ Rest",
    greeting: "¡Hola!",
    body: "Tienes un nuevo mensaje de nuestro equipo de soporte. Por favor, revísalo en tu panel de control.",
    cta: "Abrir chat de soporte",
    signature: "Saludos,<br>El equipo de IQ Rest",
  },
};
