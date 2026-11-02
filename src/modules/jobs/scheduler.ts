import cron from "node-cron";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { salesService } from "../sales/sales.service";
import { emailService } from "../emails/email.service";
import { settingsService } from "../settings/settings.service";
import { Member } from "../members/member.model";
import { Referrer } from "../referrers/referrer.model";
import { PageVisit } from "../tracking/tracking.models";
import { Admin } from "../auth/admin.model";
import { dayKey, startOfDay } from "../../common/utils/dates";
import { JobLock } from "./joblock.model";

/** Only one instance runs a given cron tick (lock document with expiry) — safe when scaled horizontally. */
async function withLock(name: string, ttlMs: number, fn: () => Promise<void>) {
  const now = new Date();
  try {
    const got = await JobLock.findOneAndUpdate({ name, $or: [{ until: { $lt: now } }, { until: null }] }, { until: new Date(now.getTime() + ttlMs) }, { upsert: true, returnDocument: "after" });
    if (!got) return;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return; // another instance holds it
    throw e;
  }
  try { await fn(); } catch (e) { logger.error(e, `job ${name} failed`); }
}

export async function sendDailySummary() {
  const s = await settingsService.get();
  if (!s.dailySummary) return;
  const end = startOfDay();
  const start = new Date(end.getTime() - 86_400_000);
  const [newSignups, newReferrers, totalMembers, visitors, top] = await Promise.all([
    Member.countDocuments({ createdAt: { $gte: start, $lt: end } }),
    Referrer.countDocuments({ createdAt: { $gte: start, $lt: end } }),
    Member.estimatedDocumentCount(),
    PageVisit.countDocuments({ visitedOn: dayKey(start) }),
    Member.aggregate([{ $match: { createdAt: { $gte: start, $lt: end }, referredBy: { $ne: null } } }, { $group: { _id: "$referredBy", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 5 }, { $lookup: { from: "referrers", localField: "_id", foreignField: "_id", as: "r" } }]),
  ]);
  const admins = await Admin.find({}, { email: 1, name: 1 }).lean();
  const topText = top.map((t) => `• ${t.r[0]?.code ?? "?"} — ${t.n} signup(s)`).join("\n") || "• none";
  for (const a of admins) {
    await emailService.enqueue("E6", { email: a.email, name: a.name, lang: "en" }, { first_name: a.name, new_signups: newSignups, new_referrers: newReferrers, total_members: totalMembers, visitors, top_referrers: topText });
  }
}

export function startScheduler() {
  if (!env.JOBS_ENABLED) return () => undefined;
  const tz = env.JOBS_TIMEZONE;
  const tasks = [
    // Pending → Approved after the holding period (daily, 02:10)
    cron.schedule("10 2 * * *", () => withLock("approve-commissions", 10 * 60_000, async () => { const n = await salesService.approveDue(); logger.info({ n }, "commissions approved"); }), { timezone: tz }),
    // E6 admin daily summary — 8 AM Houston time
    cron.schedule("0 8 * * *", () => withLock("daily-summary", 10 * 60_000, sendDailySummary), { timezone: tz }),
  ];
  // Email outbox worker (batches, Brevo daily limit)
  let busy = false;
  const iv = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await emailService.processBatch(); } catch (e) { logger.error(e, "email worker"); } finally { busy = false; }
  }, env.EMAIL_WORKER_INTERVAL_SECONDS * 1000);
  logger.info({ tz }, "Scheduler started (commission approval, daily summary, email worker)");
  return () => { tasks.forEach((t) => t.stop()); clearInterval(iv); };
}
