import rateLimit from "express-rate-limit";
import { isTest } from "../config/env";

const handler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "Too many requests, please try again later." } });

/** In-memory store by default. For several API instances, plug a shared store (e.g. rate-limit-redis). */
const make = (windowMs: number, limit: number) =>
  rateLimit({ windowMs, limit: isTest ? 10_000 : limit, standardHeaders: "draft-8", legacyHeaders: false, handler });

export const globalLimiter = make(60_000, 300);
/** SRS 6.1: max 5 signups per IP per hour. */
export const signupLimiter = rateLimit({ windowMs: 3_600_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, handler, skip: () => isTest && process.env.TEST_RATE_LIMIT !== "1" });
export const magicLinkLimiter = make(3_600_000, 5);
export const loginLimiter = make(15 * 60_000, 30);
export const trackingLimiter = make(60_000, 60);
