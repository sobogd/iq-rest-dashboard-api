import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";

async function bootstrap() {
  // rawBody: true keeps a Buffer copy of every request body on req.rawBody,
  // which Stripe webhook signature verification requires.
  const app = await NestFactory.create(AppModule, {
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
  app.use(bodyParser.json({ limit: "500mb" }));
  app.use(bodyParser.urlencoded({ limit: "500mb", extended: true }));

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
