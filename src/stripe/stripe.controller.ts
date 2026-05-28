import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
    // Per-restaurant billing — checkout creates a Stripe subscription scoped
    // to the CURRENTLY ACTIVE restaurant. Each restaurant has its own sub.
    // The Stripe customer is per-human (User.stripeCustomerId).
    const { userId, restaurantId, viaGrant } = (req as AuthedRequest).authUser;
    if (viaGrant) throw new ForbiddenException("Billing is managed by the restaurant owner");
    const stripe = getStripe();
    const [restaurant, user] = await Promise.all([
      this.prisma.restaurant.findUnique({ where: { id: restaurantId } }),
      this.prisma.user.findUnique({ where: { id: userId } }),
    ]);
    if (!restaurant) throw new BadRequestException("Restaurant not found");
    if (!user) throw new BadRequestException("User not found");

    const validKeys: string[] = [
      PRICE_LOOKUP_KEYS.BASIC_MONTHLY,
      PRICE_LOOKUP_KEYS.BASIC_YEARLY,
      PRICE_LOOKUP_KEYS.PRO_MONTHLY,
      PRICE_LOOKUP_KEYS.PRO_YEARLY,
    ];
    if (!body.priceLookupKey || !validKeys.includes(body.priceLookupKey)) {
      throw new BadRequestException("Invalid price lookup key");
    }

    // EU-only billing — Stripe checkout always uses the EUR price object.
    const baseLookupKey = body.priceLookupKey as PriceLookupKey;
    const fullLookupKey = getLookupKeyWithCurrency(baseLookupKey, "EUR");

    // When there's already an active subscription on THIS restaurant, route to
    // the Stripe Billing Portal so the switch shows the prorated charge before
    // it commits.
    if (restaurant.subscriptionStatus === "ACTIVE" && restaurant.stripeSubscriptionId) {
      const customer = user.stripeCustomerId;
      if (!customer) {
        throw new BadRequestException("Subscription is active but no Stripe customer found");
      }
      const appUrl = process.env.APP_URL;
      if (!appUrl) throw new BadRequestException("APP_URL not configured");
      const locale = body.locale || "en";
      const portal = await stripe.billingPortal.sessions.create({
        customer,
        return_url: `${appUrl}/${locale}/dashboard/settings/billing`,
      });
      return { url: portal.url };
    }

    // Reuse / create the per-user Stripe customer.
    let customerId = user.stripeCustomerId;
    if (customerId) {
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if ((existing as { deleted?: boolean }).deleted) customerId = null;
      } catch {
        customerId = null;
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { stripeCustomerId: customerId },
    });

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
      subscription_data: { metadata: { restaurantId: restaurant.id, userId: user.id } },
      metadata: { restaurantId: restaurant.id, userId: user.id },
    });

    if (!session.url) {
      throw new BadRequestException("Stripe did not return a checkout URL");
    }

    await this.prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { paymentProcessing: true },
    });

    return { url: session.url };
  }

  @Post("processing")
  @UseGuards(AuthGuard)
  async setProcessing(@Req() req: Request) {
    const { restaurantId, viaGrant } = (req as AuthedRequest).authUser;
    if (viaGrant) throw new ForbiddenException("Billing is managed by the restaurant owner");
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { paymentProcessing: true },
    });
    return { success: true };
  }

  @Post("portal")
  @UseGuards(AuthGuard)
  async createPortal(@Req() req: Request, @Body() body: { locale?: string }) {
    const { userId, viaGrant } = (req as AuthedRequest).authUser;
    if (viaGrant) throw new ForbiddenException("Billing is managed by the restaurant owner");
    const stripe = getStripe();
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.stripeCustomerId) {
      throw new BadRequestException("No subscription found");
    }
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new BadRequestException("APP_URL not configured");
    const locale = body?.locale || "en";
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
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
        const fallbackRestaurantId = session.metadata?.restaurantId ?? null;
        if (subId) {
          const targetRestaurantId = await this.resolveRestaurantId(subId, fallbackRestaurantId);
          if (targetRestaurantId) {
            const sub = (await stripe.subscriptions.retrieve(subId)) as unknown as SubscriptionData;
            await this.applySubscription(targetRestaurantId, sub);
          }
        } else if (fallbackRestaurantId) {
          await this.prisma.restaurant.update({
            where: { id: fallbackRestaurantId },
            data: { paymentProcessing: false },
          }).catch(() => undefined);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as unknown as SubscriptionData;
        const targetRestaurantId = await this.resolveRestaurantId(sub.id, null);
        if (targetRestaurantId) {
          if (event.type === "customer.subscription.created") {
            // Cancel the previous subscription on THIS restaurant.
            const r = await this.prisma.restaurant.findUnique({
              where: { id: targetRestaurantId },
              select: { stripeSubscriptionId: true },
            });
            if (r?.stripeSubscriptionId && r.stripeSubscriptionId !== sub.id) {
              try {
                await stripe.subscriptions.cancel(r.stripeSubscriptionId);
              } catch (err) {
                console.error("Cancel old sub error:", err);
              }
            }
          }
          await this.applySubscription(targetRestaurantId, sub);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as unknown as SubscriptionData;
        const targetRestaurantId = await this.resolveRestaurantId(sub.id, null);
        if (targetRestaurantId) {
          const r = await this.prisma.restaurant.findUnique({
            where: { id: targetRestaurantId },
            select: { stripeSubscriptionId: true },
          });
          if (r?.stripeSubscriptionId === sub.id) {
            await this.prisma.restaurant.update({
              where: { id: targetRestaurantId },
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
          const targetRestaurantId = await this.resolveRestaurantId(invoice.subscription, null);
          if (targetRestaurantId) {
            await this.prisma.restaurant.update({
              where: { id: targetRestaurantId },
              data: { subscriptionStatus: "ACTIVE", paymentProcessing: false },
            });
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as { subscription?: string | null };
        if (invoice.subscription) {
          const targetRestaurantId = await this.resolveRestaurantId(invoice.subscription, null);
          if (targetRestaurantId) {
            await this.prisma.restaurant.update({
              where: { id: targetRestaurantId },
              data: { subscriptionStatus: "PAST_DUE" },
            });
          }
        }
        break;
      }
    }

    return { received: true };
  }

  /** Find the restaurantId for a Stripe subscription event.
   *  Prefers Restaurant.stripeSubscriptionId; falls back to subscription
   *  metadata for fresh ones whose DB row has not been written yet
   *  (checkout.session.completed race); finally falls back to looking up the
   *  customer's first attached restaurant. */
  private async resolveRestaurantId(
    subscriptionId: string,
    fallbackRestaurantId: string | null,
  ): Promise<string | null> {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
      select: { id: true },
    });
    if (restaurant) return restaurant.id;

    try {
      const stripe = getStripe();
      const sub = (await stripe.subscriptions.retrieve(subscriptionId)) as unknown as SubscriptionData;
      const metaRestaurantId = sub.metadata?.restaurantId || fallbackRestaurantId;
      if (metaRestaurantId) {
        const r = await this.prisma.restaurant.findUnique({
          where: { id: metaRestaurantId },
          select: { id: true },
        });
        if (r) return r.id;
      }
      if (sub.customer) {
        const byCustomer = await this.prisma.user.findFirst({
          where: { stripeCustomerId: sub.customer },
          select: { id: true },
        });
        if (byCustomer) {
          const ru = await this.prisma.restaurantUser.findFirst({
            where: { userId: byCustomer.id },
            orderBy: { addedAt: "asc" },
            select: { restaurantId: true },
          });
          if (ru) return ru.restaurantId;
        }
      }
    } catch (err) {
      console.error("resolveRestaurantId:", err);
    }
    return null;
  }

  private async applySubscription(
    restaurantId: string,
    sub: SubscriptionData,
  ): Promise<void> {
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

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
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
