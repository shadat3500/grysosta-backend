import type { Request } from "express";
import { sha256 } from "./utils/crypto";
import { env } from "../config/env";

export const clientIp = (req: Request) => req.ip || req.socket.remoteAddress || "0.0.0.0";

/** Country from CDN headers (Vercel / Cloudflare) — we never store the full IP. */
export const ipCountry = (req: Request) =>
  String(req.headers["x-vercel-ip-country"] || req.headers["cf-ipcountry"] || "").slice(0, 2).toUpperCase() || "US";

/** SRS 10 privacy: hash of IP + user agent. */
export const visitorHash = (req: Request) => sha256(`${env.HASH_SALT}|${clientIp(req)}|${req.headers["user-agent"] || ""}`).slice(0, 40);

export const userAgent = (req: Request) => String(req.headers["user-agent"] || "").slice(0, 200);
