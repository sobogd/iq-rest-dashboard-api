import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle, seconds, minutes } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

const COOKIE_NAME = "analytics_sid";
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const EVENT_REGEX = /^[a-z0-9_]{1,64}$/;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;
// Accept UUID v4 from this controller and cuid from prior IDs (admin reuse).
// cuid: starts with "c", 25 chars total, [a-z0-9]. UUID: standard form.
const SID_REGEX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{24})$/i;

interface EventBody {
  event?: string;
  occurredAt?: string;
}

function getApexDomain(): string | undefined {
  return process.env.ANALYTICS_COOKIE_DOMAIN || undefined;
}

function cookieOptions() {
  return {
    domain: getApexDomain(),
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
    sameSite: "lax" as const,
    secure: process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
    httpOnly: false,
  };
}

function readCookie(req: Request, name: string): string | undefined {
  const fromParser = (req.cookies as Record<string, string | undefined> | undefined)?.[name];
  if (fromParser) return fromParser;
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

function ensureSessionCookie(req: Request, res: Response): string {
  const existing = readCookie(req, COOKIE_NAME);
  if (existing && SID_REGEX.test(existing)) return existing;
  const sessionId = randomUUID();
  res.cookie(COOKIE_NAME, sessionId, cookieOptions());
  return sessionId;
}

function extractIp(req: Request): string | null {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.ip ?? null;
}

function parseOccurredAt(raw: string | undefined): Date {
  if (!raw) throw new BadRequestException("occurredAt required");
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException("occurredAt invalid");
  const now = Date.now();
  if (d.getTime() > now + FUTURE_TOLERANCE_MS) {
    throw new BadRequestException("occurredAt too far in future");
  }
  if (d.getTime() < now - PAST_TOLERANCE_MS) {
    throw new BadRequestException("occurredAt too far in past");
  }
  return d;
}

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  // 30 events/sec burst (covers 10-20 events/sec sustained per active user)
  // and 1500/min sustained per IP. Anonymous endpoint, no auth.
  @Throttle({
    burst: { ttl: seconds(1), limit: 30 },
    sustained: { ttl: minutes(1), limit: 1500 },
  })
  @Post("event")
  @HttpCode(HttpStatus.OK)
  async event(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: EventBody,
  ) {
    if (!body.event || !EVENT_REGEX.test(body.event)) {
      throw new BadRequestException("event invalid");
    }
    const occurredAt = parseOccurredAt(body.occurredAt);
    const sessionId = ensureSessionCookie(req, res);
    const ip = extractIp(req);
    const ua = req.headers["user-agent"] || null;

    await this.prisma.session.upsert({
      where: { id: sessionId },
      create: { id: sessionId, ip, userAgent: ua },
      update: {},
    });

    await this.prisma.analyticsEvent.create({
      data: { sessionId, event: body.event, occurredAt },
    });

    return { ok: true };
  }

  @Post("identify")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async identify(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { userId, companyId } = (req as AuthedRequest).authUser;
    const currentId = ensureSessionCookie(req, res);

    const previous = await this.prisma.session.findFirst({
      where: { userId, NOT: { id: currentId } },
      orderBy: { createdAt: "asc" },
      select: { id: true, companyId: true },
    });

    if (previous) {
      await this.prisma.$transaction([
        this.prisma.analyticsEvent.updateMany({
          where: { sessionId: currentId },
          data: { sessionId: previous.id },
        }),
        this.prisma.session.deleteMany({ where: { id: currentId } }),
        this.prisma.session.update({
          where: { id: previous.id },
          data: { companyId: previous.companyId ?? companyId },
        }),
      ]);
      res.cookie(COOKIE_NAME, previous.id, cookieOptions());
      return { sessionId: previous.id };
    }

    await this.prisma.session.upsert({
      where: { id: currentId },
      create: { id: currentId, userId, companyId },
      update: { userId, companyId },
    });
    return { sessionId: currentId };
  }
}
