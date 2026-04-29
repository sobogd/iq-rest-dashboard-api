import { Controller, Get, Req } from "@nestjs/common";
import type { Request } from "express";
import { getRequestCountry, getRequestCurrency } from "../common/geo";

@Controller("geo")
export class GeoController {
  @Get("currency")
  async currency(@Req() req: Request) {
    const [country, currency] = await Promise.all([
      getRequestCountry(req),
      getRequestCurrency(req),
    ]);
    return { country, currency };
  }
}
