import "dotenv/config";
import { z } from "zod";

const bool = z.union([z.boolean(), z.string()]).transform((v) => v === true || v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_PREFIX: z.string().default("/api/v1"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  SITE_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  TRUST_PROXY: z.coerce.number().default(1),
  MONGODB_URI: z.string().min(1),
  HASH_SALT: z.string().min(8),
  SESSION_IDLE_MINUTES: z.coerce.number().default(120),
  SESSION_MAX_HOURS: z.coerce.number().default(24),
  COOKIE_SECURE: bool.default(false),
  ADMIN_EMAIL: z.string().email().default("admin@grysosta.com"),
  ADMIN_PASSWORD: z.string().default(""),
  ADMIN_NAME: z.string().default("Admin"),
  BREVO_API_KEY: z.string().default(""),
  EMAIL_FROM_NAME: z.string().default("GRYSOSTA Stock Trading Academy"),
  EMAIL_FROM_ADDRESS: z.string().email().default("vip@grysosta.com"),
  EMAIL_DAILY_LIMIT: z.coerce.number().default(300),
  EMAIL_BATCH_SIZE: z.coerce.number().default(50),
  EMAIL_WORKER_INTERVAL_SECONDS: z.coerce.number().default(10),
  TURNSTILE_SECRET: z.string().default(""),
  JOBS_ENABLED: bool.default(true),
  JOBS_TIMEZONE: z.string().default("America/Chicago"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment variables:", z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
export const corsOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
