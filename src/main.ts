import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";

async function bootstrap() {
  // rawBody: true keeps a Buffer copy of every request body on req.rawBody,
  // which Stripe webhook signature verification requires.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(ConfigService);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      strictTransportSecurity: false,
      crossOriginResourcePolicy: false,
    }),
  );
  app.use(cookieParser());
  // Authenticated endpoints accept large file uploads (PDF menus, photos).
  // Use Nest's built-in body parsers (already installed by rawBody:true) and
  // only bump the limit — registering a second bodyParser.json via app.use
  // consumes the stream twice and breaks every POST/PATCH with a body.
  app.useBodyParser("json", { limit: "500mb" });
  app.useBodyParser("urlencoded", { limit: "500mb", extended: true });

  const corsOrigins = (config.get<string>("CORS_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix("api");

  const port = Number(config.get<string>("PORT") ?? 4000);
  await app.listen(port);

  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${port}`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start app", e);
  process.exit(1);
});
