import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import mongoose from "mongoose";
import { MulterError } from "multer";
import { corsOrigins, env, isProd } from "./config/env";
import { logger } from "./config/logger";
import { apiRouter } from "./routes";
import { AppError } from "./common/errors";
import { globalLimiter } from "./common/rateLimit";
import { UPLOAD_DIR } from "./common/upload";
import { stripeWebhookHandler } from "./modules/payments/payment.routes";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, hsts: { maxAge: 63072000, includeSubDomains: true, preload: true } }));
  app.use(cors({ origin: corsOrigins, credentials: true }));
  // Stripe webhook needs the raw body (signature check) → registered before express.json.
  app.post(`${env.API_PREFIX}/public/stripe/webhook`, express.raw({ type: "application/json", limit: "1mb" }), stripeWebhookHandler);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));

  app.get("/health", async (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ status: db ? "ok" : "degraded", db, uptime: Math.round(process.uptime()), time: new Date().toISOString() });
  });
  app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d", immutable: true, index: false }));

  app.use(env.API_PREFIX, globalLimiter, apiRouter);

  app.use((req, _res, next) => next(new AppError(404, "NOT_FOUND", `Route ${req.method} ${req.path} not found`)));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof MulterError) return res.status(400).json({ success: false, error: { code: "UPLOAD_ERROR", message: err.code === "LIMIT_FILE_SIZE" ? "File is too large" : err.message } });
    if (err instanceof mongoose.Error.ValidationError) return res.status(400).json({ success: false, error: { code: "BAD_REQUEST", message: "Validation failed", details: Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, [v.message]])) } });
    if (err instanceof mongoose.Error.CastError) return res.status(400).json({ success: false, error: { code: "BAD_REQUEST", message: `Invalid ${err.path}` } });
    if ((err as { code?: number }).code === 11000) return res.status(409).json({ success: false, error: { code: "CONFLICT", message: "Duplicate value", details: (err as { keyValue?: unknown }).keyValue } });
    if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ success: false, error: { code: "BAD_JSON", message: "Malformed JSON body" } });
    req.log?.error(err);
    res.status(500).json({ success: false, error: { code: "INTERNAL", message: isProd ? "Something went wrong" : String((err as Error)?.message ?? err) } });
  });

  return app;
}
