import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { Plan, BillingCycle, SubscriptionStatus } from "@prisma/client";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import {
  getStripe,
  PRICE_LOOKUP_KEYS,
  type PriceLookupKey,
  getLookupKeyWithCurrency,
} from "../common/stripe";

interface SubscriptionData {
  id: string;
  status: string;
  current_period_end?: number;
  items: { data: Array<{ current_period_end?: number; price: { id: string; lookup_key?: string | null } }> };
  metadata?: Record<string, string>;
  customer?: string;
}

@Controller("stripe")
export class StripeController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("checkout")
  @UseGuards(AuthGuard)
  async createCheckout(
    @Req() req: Request,
    @Body() body: { priceLookupKey?: string; locale?: string; currency?: string },
  ) {
    const { companyId } = (req as AuthedRequest).authUser;
    const stripe = getStripe();
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new BadRequestException("Company not found");

    const validKeys: string[] = [PRICE_LOOKUP_KEYS.BASIC_MONTHLY, PRICE_LOOKUP_KEYS.BASIC_YEARLY];
    if (!body.priceLookupKey || !validKeys.includes(body.priceLookupKey)) {
      throw new BadRequestException("Invalid price lookup key");
    }
    if (company.subscriptionStatus === "ACTIVE" && company.stripeSubscriptionId) {
      throw new BadRequestException("Active subscription already exists");
    }

    // EU-only billing — Stripe checkout always uses the EUR price object.
    const baseLookupKey = body.priceLookupKey as PriceLookupKey;
    const fullLookupKey = getLookupKeyWithCurrency(baseLookupKey, "EUR");

    let customerId = company.stripeCustomerId;
    if (customerId) {
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if ((existing as { deleted?: boolean }).deleted) customerId = null;
      } catch {
        customerId = null;
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { companyId: company.id } });
      customerId = customer.id;
      await this.prisma.company.update({ where: { id: company.id }, data: { stripeCustomerId: customerId } });
    }

    let prices = await stripe.prices.list({ lookup_keys: [fullLookupKey], active: true, limit: 1 });
    if (prices.data.length === 0) {
      // Fallback to base lookup key without currency suffix.
      prices = await stripe.prices.list({ lookup_keys: [baseLookupKey], active: true, limit: 1 });
    }
    if (prices.data.length === 0) {
      throw new BadRequestException(`Price not found for ${fullLookupKey} or ${baseLookupKey}`);
    }

    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new BadRequestException("APP_URL not configured");
    const locale = body.locale || "en";
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: prices.data[0].id, quantity: 1 }],
      success_url: `${appUrl}/${locale}/dashboard/settings/billing?success=true`,
      cancel_url: `${appUrl}/${locale}/dashboard/settings/billing?canceled=true`,
      subscription_data: { metadata: { companyId: company.id } },
      metadata: { companyId: company.id },
    });

    if (!session.url) {
      throw new BadRequestException("Stripe did not return a checkout URL");
    }

    await this.prisma.company.update({
      where: { id: company.id },
      data: { paymentProcessing: true },
    });

    return { url: session.url };
  }

  @Post("processing")
  @UseGuards(AuthGuard)
  async setProcessing(@Req() req: Request) {
    const { companyId } = (req as AuthedRequest).authUser;
    await this.prisma.company.update({
      where: { id: companyId },
      data: { paymentProcessing: true },
    });
    return { success: true };
  }

  @Post("portal")
  @UseGuards(AuthGuard)
  async createPortal(@Req() req: Request, @Body() body: { locale?: string }) {
    const { companyId } = (req as AuthedRequest).authUser;
    const stripe = getStripe();
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company || !company.stripeCustomerId) {
      throw new BadRequestException("No subscription found");
    }
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new BadRequestException("APP_URL not configured");
    const locale = body?.locale || "en";
    const session = await stripe.billingPortal.sessions.create({
      customer: company.stripeCustomerId,
      return_url: `${appUrl}/${locale}/dashboard/settings/billing`,
    });
    return { url: session.url };
  }

  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: Request, @Headers("stripe-signature") signature?: string) {
    if (!signature) throw new BadRequestException("Missing stripe-signature");
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new BadRequestException("STRIPE_WEBHOOK_SECRET not configured");
    const stripe = getStripe();

    const rawBody: Buffer = (req as unknown as { rawBody?: Buffer }).rawBody as Buffer;
    if (!rawBody) throw new BadRequestException("Missing raw body");

    let event: { type: string; data: { object: unknown } };
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret) as { type: string; data: { object: unknown } };
    } catch (e) {
      console.error("Webhook signature verification failed:", e);
      throw new BadRequestException("Invalid signature");
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as { subscription?: string; metadata?: Record<string, string> };
        const subId = session.subscription;
        const fallbackCompanyId = session.metadata?.companyId ?? null;
        if (subId) {
          const companyId =
            (await this.companyFromSubscription(subId)) ?? fallbackCompanyId;
          if (companyId) {
            const sub = (await stripe.subscriptions.retrieve(subId)) as unknown as SubscriptionData;
            await this.applySubscription(companyId, sub);
          }
        } else if (fallbackCompanyId) {
          await this.prisma.company.update({
            where: { id: fallbackCompanyId },
            data: { paymentProcessing: false },
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as unknown as SubscriptionData;
        const companyId = await this.companyFromSubscription(sub.id);
        if (companyId) {
          if (event.type === "customer.subscription.created") {
            const company = await this.prisma.company.findUnique({
              where: { id: companyId },
              select: { stripeSubscriptionId: true },
            });
            if (company?.stripeSubscriptionId && company.stripeSubscriptionId !== sub.id) {
              try {
                await stripe.subscriptions.cancel(company.stripeSubscriptionId);
              } catch (err) {
                console.error("Cancel old sub error:", err);
              }
            }
          }
          await this.applySubscription(companyId, sub);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as unknown as SubscriptionData;
        const companyId = await this.companyFromSubscription(sub.id);
        if (companyId) {
          const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { stripeSubscriptionId: true },
          });
          if (company?.stripeSubscriptionId === sub.id) {
            await this.prisma.company.update({
              where: { id: companyId },
              data: {
                plan: "FREE",
                billingCycle: null,
                subscriptionStatus: "CANCELED",
                currentPeriodEnd: null,
                stripeSubscriptionId: null,
                paymentProcessing: false,
              },
            });
          }
        }
        break;
      }
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as { subscription?: string | null };
        if (invoice.subscription) {
          const companyId = await this.companyFromSubscription(invoice.subscription);
          if (companyId) {
            await this.prisma.company.update({
              where: { id: companyId },
              data: { subscriptionStatus: "ACTIVE", paymentProcessing: false },
            });
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as { subscription?: string | null };
        if (invoice.subscription) {
          const companyId = await this.companyFromSubscription(invoice.subscription);
          if (companyId) {
            await this.prisma.company.update({
              where: { id: companyId },
              data: { subscriptionStatus: "PAST_DUE" },
            });
          }
        }
        break;
      }
    }

    return { received: true };
  }

  private async companyFromSubscription(subscriptionId: string): Promise<string | null> {
    const company = await this.prisma.company.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
    });
    if (company) return company.id;

    try {
      const stripe = getStripe();
      const sub = (await stripe.subscriptions.retrieve(subscriptionId)) as unknown as SubscriptionData;
      const metaCompanyId = sub.metadata?.companyId;
      if (metaCompanyId) return metaCompanyId;
      if (sub.customer) {
        const byCustomer = await this.prisma.company.findFirst({
          where: { stripeCustomerId: sub.customer },
        });
        return byCustomer?.id ?? null;
      }
    } catch (err) {
      console.error("companyFromSubscription:", err);
    }
    return null;
  }

  private async applySubscription(companyId: string, sub: SubscriptionData): Promise<void> {
    const item = sub.items.data[0];
    const lookupKey = item?.price.lookup_key;

    let plan: Plan = "FREE";
    let billingCycle: BillingCycle | null = null;
    if (lookupKey) {
      if (lookupKey.startsWith(PRICE_LOOKUP_KEYS.BASIC_MONTHLY)) {
        plan = "BASIC"; billingCycle = "MONTHLY";
      } else if (lookupKey.startsWith(PRICE_LOOKUP_KEYS.BASIC_YEARLY)) {
        plan = "BASIC"; billingCycle = "YEARLY";
      } else if (lookupKey.startsWith(PRICE_LOOKUP_KEYS.PRO_MONTHLY)) {
        plan = "PRO"; billingCycle = "MONTHLY";
      } else if (lookupKey.startsWith(PRICE_LOOKUP_KEYS.PRO_YEARLY)) {
        plan = "PRO"; billingCycle = "YEARLY";
      }
    }

    let subscriptionStatus: SubscriptionStatus = "INACTIVE";
    switch (sub.status) {
      case "active":
      case "trialing":
        subscriptionStatus = "ACTIVE"; break;
      case "past_due":
        subscriptionStatus = "PAST_DUE"; break;
      case "canceled":
      case "unpaid":
        subscriptionStatus = "CANCELED"; break;
      case "incomplete":
      case "incomplete_expired":
        subscriptionStatus = "EXPIRED"; break;
    }

    const periodEnd = item?.current_period_end ?? sub.current_period_end;
    let currentPeriodEnd: Date | null = null;
    if (typeof periodEnd === "number" && periodEnd > 0) {
      const d = new Date(periodEnd * 1000);
      if (!isNaN(d.getTime())) currentPeriodEnd = d;
    }

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        stripeSubscriptionId: sub.id,
        plan,
        billingCycle,
        subscriptionStatus,
        currentPeriodEnd,
        paymentProcessing: false,
      },
    });
  }
}
