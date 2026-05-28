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
    // Per-restaurant billing — checkout creates a subscription for the
    // CURRENTLY ACTIVE restaurant. Each restaurant has its own subscription.
    const { userId, companyId, restaurantId, viaGrant } = (req as AuthedRequest).authUser;
    if (viaGrant) throw new ForbiddenException("Billing is managed by the restaurant owner");
    const stripe = getStripe();
    const [company, restaurant, user] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId } }),
      this.prisma.restaurant.findUnique({ where: { id: restaurantId } }),
      this.prisma.user.findUnique({ where: { id: userId } }),
    ]);
    if (!company) throw new BadRequestException("Company not found");
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
    // it commits. (Subscriptions are per-restaurant now — switching plan on
    // restaurant A doesn't affect restaurant B.)
    if (restaurant.subscriptionStatus === "ACTIVE" && restaurant.stripeSubscriptionId) {
      const customer = user.stripeCustomerId || company.stripeCustomerId;
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

    // Stripe customer is per-human now. Prefer User.stripeCustomerId, fall
    // back to legacy Company.stripeCustomerId, create a fresh one if neither
    // exists. Dual-write to both User and Company during transition.
    let customerId = user.stripeCustomerId || company.stripeCustomerId;
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
        metadata: { userId: user.id, companyId: company.id },
      });
      customerId = customer.id;
    }
    // Always dual-write so legacy reads continue to work during transition.
    await Promise.all([
      this.prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } }),
      this.prisma.company.update({ where: { id: company.id }, data: { stripeCustomerId: customerId } }),
    ]);

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
      // restaurantId carries the per-restaurant target; companyId stays for
      // legacy webhook compat during transition.
      subscription_data: { metadata: { companyId: company.id, restaurantId: restaurant.id, userId: user.id } },
      metadata: { companyId: company.id, restaurantId: restaurant.id, userId: user.id },
    });

    if (!session.url) {
      throw new BadRequestException("Stripe did not return a checkout URL");
    }

    // Dual-write paymentProcessing on both Company and Restaurant so any UI
    // path (legacy company-scoped or new restaurant-scoped) reflects the
    // pending checkout.
    await Promise.all([
      this.prisma.company.update({ where: { id: company.id }, data: { paymentProcessing: true } }),
      this.prisma.restaurant.update({ where: { id: restaurant.id }, data: { paymentProcessing: true } }),
    ]);

    return { url: session.url };
  }

  @Post("processing")
  @UseGuards(AuthGuard)
  async setProcessing(@Req() req: Request) {
    const { companyId, viaGrant } = (req as AuthedRequest).authUser;
    if (viaGrant) throw new ForbiddenException("Billing is managed by the restaurant owner");
    await this.prisma.company.update({
      where: { id: companyId },
      data: { paymentProcessing: true },
    });
    return { success: true };
  }

  @Post("portal")
  @UseGuards(AuthGuard)
  async createPortal(@Req() req: Request, @Body() body: { locale?: string }) {
    const { companyId, viaGrant } = (req as AuthedRequest).authUser;
    if (viaGrant) throw new ForbiddenException("Billing is managed by the restaurant owner");
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
        const fallbackRestaurantId = session.metadata?.restaurantId ?? null;
        if (subId) {
          const target = await this.resolveTarget(subId, fallbackCompanyId, fallbackRestaurantId);
          if (target) {
            const sub = (await stripe.subscriptions.retrieve(subId)) as unknown as SubscriptionData;
            await this.applySubscription(target.companyId, target.restaurantId, sub);
          }
        } else if (fallbackCompanyId) {
          await this.prisma.company.update({
            where: { id: fallbackCompanyId },
            data: { paymentProcessing: false },
          });
          if (fallbackRestaurantId) {
            await this.prisma.restaurant.update({
              where: { id: fallbackRestaurantId },
              data: { paymentProcessing: false },
            }).catch(() => undefined);
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as unknown as SubscriptionData;
        const target = await this.resolveTarget(sub.id, null, null);
        if (target) {
          if (event.type === "customer.subscription.created") {
            // Cancel the previous subscription on THIS restaurant (not company-
            // wide — other restaurants of the same owner keep their own subs).
            const restaurant = await this.prisma.restaurant.findUnique({
              where: { id: target.restaurantId },
              select: { stripeSubscriptionId: true },
            });
            if (restaurant?.stripeSubscriptionId && restaurant.stripeSubscriptionId !== sub.id) {
              try {
                await stripe.subscriptions.cancel(restaurant.stripeSubscriptionId);
              } catch (err) {
                console.error("Cancel old sub error:", err);
              }
            }
          }
          await this.applySubscription(target.companyId, target.restaurantId, sub);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as unknown as SubscriptionData;
        const target = await this.resolveTarget(sub.id, null, null);
        if (target) {
          const restaurant = await this.prisma.restaurant.findUnique({
            where: { id: target.restaurantId },
            select: { stripeSubscriptionId: true },
          });
          if (restaurant?.stripeSubscriptionId === sub.id) {
            await Promise.all([
              this.prisma.restaurant.update({
                where: { id: target.restaurantId },
                data: {
                  plan: "FREE",
                  billingCycle: null,
                  subscriptionStatus: "CANCELED",
                  currentPeriodEnd: null,
                  stripeSubscriptionId: null,
                  paymentProcessing: false,
                },
              }),
              // Legacy dual-write so the old admin UI does not lag.
              this.prisma.company.update({
                where: { id: target.companyId },
                data: {
                  plan: "FREE",
                  billingCycle: null,
                  subscriptionStatus: "CANCELED",
                  currentPeriodEnd: null,
                  stripeSubscriptionId: null,
                  paymentProcessing: false,
                },
              }).catch(() => undefined),
            ]);
          }
        }
        break;
      }
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as { subscription?: string | null };
        if (invoice.subscription) {
          const target = await this.resolveTarget(invoice.subscription, null, null);
          if (target) {
            await Promise.all([
              this.prisma.restaurant.update({
                where: { id: target.restaurantId },
                data: { subscriptionStatus: "ACTIVE", paymentProcessing: false },
              }),
              this.prisma.company.update({
                where: { id: target.companyId },
                data: { subscriptionStatus: "ACTIVE", paymentProcessing: false },
              }).catch(() => undefined),
            ]);
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as { subscription?: string | null };
        if (invoice.subscription) {
          const target = await this.resolveTarget(invoice.subscription, null, null);
          if (target) {
            await Promise.all([
              this.prisma.restaurant.update({
                where: { id: target.restaurantId },
                data: { subscriptionStatus: "PAST_DUE" },
              }),
              this.prisma.company.update({
                where: { id: target.companyId },
                data: { subscriptionStatus: "PAST_DUE" },
              }).catch(() => undefined),
            ]);
          }
        }
        break;
      }
    }

    return { received: true };
  }

  /** Find the (companyId, restaurantId) target for a Stripe subscription event.
   *  Prefers the new Restaurant.stripeSubscriptionId lookup; falls back to the
   *  legacy Company.stripeSubscriptionId path; finally falls back to metadata
   *  on the Stripe subscription itself for fresh ones whose DB rows have not
   *  been written yet (checkout.session.completed race). */
  private async resolveTarget(
    subscriptionId: string,
    fallbackCompanyId: string | null,
    fallbackRestaurantId: string | null,
  ): Promise<{ companyId: string; restaurantId: string } | null> {
    // Primary: Restaurant.stripeSubscriptionId.
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
      select: { id: true, companyId: true },
    });
    if (restaurant) return { companyId: restaurant.companyId, restaurantId: restaurant.id };

    // Secondary: legacy Company.stripeSubscriptionId — derive restaurant by
    // picking the company's first (or active-cookie-tracked) restaurant.
    const company = await this.prisma.company.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
      select: { id: true },
    });
    if (company) {
      const r = await this.prisma.restaurant.findFirst({
        where: { companyId: company.id },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (r) return { companyId: company.id, restaurantId: r.id };
    }

    // Tertiary: metadata on the Stripe subscription itself.
    try {
      const stripe = getStripe();
      const sub = (await stripe.subscriptions.retrieve(subscriptionId)) as unknown as SubscriptionData;
      const metaRestaurantId = sub.metadata?.restaurantId || fallbackRestaurantId;
      const metaCompanyId = sub.metadata?.companyId || fallbackCompanyId;
      if (metaRestaurantId) {
        const r = await this.prisma.restaurant.findUnique({
          where: { id: metaRestaurantId },
          select: { id: true, companyId: true },
        });
        if (r) return { companyId: r.companyId, restaurantId: r.id };
      }
      if (metaCompanyId) {
        const r = await this.prisma.restaurant.findFirst({
          where: { companyId: metaCompanyId },
          orderBy: { createdAt: "asc" },
          select: { id: true, companyId: true },
        });
        if (r) return { companyId: r.companyId, restaurantId: r.id };
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
            select: { restaurant: { select: { id: true, companyId: true } } },
          });
          if (ru) return { companyId: ru.restaurant.companyId, restaurantId: ru.restaurant.id };
        }
      }
    } catch (err) {
      console.error("resolveTarget:", err);
    }
    return null;
  }

  private async applySubscription(
    companyId: string,
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

    // Dual-write: new per-restaurant fields + legacy company fields so any
    // unrefactored UI / endpoint still reflects the latest state.
    await Promise.all([
      this.prisma.restaurant.update({
        where: { id: restaurantId },
        data: {
          stripeSubscriptionId: sub.id,
          plan,
          billingCycle,
          subscriptionStatus,
          currentPeriodEnd,
          paymentProcessing: false,
        },
      }),
      this.prisma.company.update({
        where: { id: companyId },
        data: {
          stripeSubscriptionId: sub.id,
          plan,
          billingCycle,
          subscriptionStatus,
          currentPeriodEnd,
          paymentProcessing: false,
        },
      }).catch(() => undefined),
    ]);
  }
}
