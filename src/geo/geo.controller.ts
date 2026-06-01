import { Controller, Get, Req } from "@nestjs/common";
import type { Request } from "express";
import { getRequestCountry, getRequestCurrency, getRequestBillingCurrency } from "../common/geo";

@Controller("geo")
export class GeoController {
  @Get("currency")
  async currency(@Req() req: Request) {
    // `currency` = public-menu currency (broad); `billingCurrency` = IQ Rest
    // subscription currency (EUR/NOK/SEK/DKK).
    return {
      country: getRequestCountry(req),
      currency: getRequestCurrency(req),
      billingCurrency: getRequestBillingCurrency(req),
    };
  }
}
