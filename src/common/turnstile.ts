import { env } from "../config/env";
import { logger } from "../config/logger";

/** Cloudflare Turnstile server check (SRS 6.1). Disabled when TURNSTILE_SECRET is empty (local dev). */
export async function verifyBotToken(token: string | undefined, ip: string) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    const j = (await r.json()) as { success?: boolean };
    return !!j.success;
  } catch (e) {
    logger.error(e, "Turnstile verification failed");
    return false;
  }
}
