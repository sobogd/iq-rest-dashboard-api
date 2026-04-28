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
}
