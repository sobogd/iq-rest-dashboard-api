import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Thin wrapper over the WhatsApp Cloud API (Graph). Configured via env:
 *  WHATSAPP_TOKEN (permanent system-user token), WHATSAPP_PHONE_NUMBER_ID,
 *  WHATSAPP_VERIFY_TOKEN (webhook verify), WHATSAPP_APP_SECRET (signature). */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(private readonly config: ConfigService) {}

  get verifyToken(): string {
    return this.config.get<string>("WHATSAPP_VERIFY_TOKEN") || "";
  }

  get appSecret(): string {
    return this.config.get<string>("WHATSAPP_APP_SECRET") || "";
  }

  isConfigured(): boolean {
    return !!(
      this.config.get<string>("WHATSAPP_TOKEN") &&
      this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID")
    );
  }

  /** Send a plain-text WhatsApp message. Returns the provider message id. */
  async sendText(toPhone: string, body: string): Promise<{ ok: boolean; wamid?: string; error?: unknown }> {
    const token = this.config.get<string>("WHATSAPP_TOKEN");
    const phoneId = this.config.get<string>("WHATSAPP_PHONE_NUMBER_ID");
    if (!token || !phoneId) return { ok: false, error: "WhatsApp not configured" };
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toPhone,
          type: "text",
          text: { preview_url: false, body },
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: unknown;
      };
      if (!res.ok) {
        this.logger.warn(`WhatsApp send failed (${res.status}): ${JSON.stringify(json)}`);
        return { ok: false, error: json.error ?? json };
      }
      return { ok: true, wamid: json.messages?.[0]?.id };
    } catch (e) {
      this.logger.error(`WhatsApp send error: ${String(e)}`);
      return { ok: false, error: String(e) };
    }
  }
}
