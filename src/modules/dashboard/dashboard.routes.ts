import { Router } from "express";
import { ok } from "../../common/http";
import { round2 } from "../../common/utils/money";
import { dayKey, startOfDay } from "../../common/utils/dates";
import { Member } from "../members/member.model";
import { Referrer } from "../referrers/referrer.model";
import { Sale } from "../sales/sales.models";
import { Payout } from "../payouts/payout.model";
import { PageVisit } from "../tracking/tracking.models";
import { referrerService } from "../referrers/referrer.service";
import { sortRows } from "../referrers/referrer.routes";
import { settingsService } from "../settings/settings.service";

export const dashboardRouter = Router();

/** A2 — cards, signups per day (30 days), EN vs ES, top 10 referrers, last 10 signups, site mode. */
dashboardRouter.get("/", async (_req, res) => {
  const today = startOfDay();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const since = new Date(today.getTime() - 29 * 86_400_000);
  const [total, newToday, newWeek, referrers, activeReferrers, visitorsToday, sales, owedAgg, paidAgg, langAgg, perDay, visitsPerDay, last, s] = await Promise.all([
    Member.estimatedDocumentCount(),
    Member.countDocuments({ createdAt: { $gte: today } }),
    Member.countDocuments({ createdAt: { $gte: weekAgo } }),
    Referrer.countDocuments({ deletedMember: { $ne: true } }),
    Referrer.countDocuments({ status: "active", deletedMember: { $ne: true } }),
    PageVisit.countDocuments({ visitedOn: dayKey() }),
    Sale.countDocuments({ refunded: false }),
    Sale.aggregate([{ $match: { commissionStatus: { $in: ["pending", "approved"] } } }, { $group: { _id: null, n: { $sum: "$commissionAmount" } } }]),
    Payout.aggregate([{ $group: { _id: null, n: { $sum: "$amount" }, c: { $sum: 1 } } }]),
    Member.aggregate([{ $group: { _id: "$language", n: { $sum: 1 } } }]),
    Member.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, n: { $sum: 1 } } }]),
    PageVisit.aggregate([{ $match: { visitedOn: { $gte: dayKey(since) } } }, { $group: { _id: "$visitedOn", n: { $sum: 1 } } }]),
    Member.find({}, { firstName: 1, lastName: 1, email: 1, language: 1, referredBy: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(10).populate("referredBy", "code").lean(),
    settingsService.get(),
  ]);
  const pd = new Map(perDay.map((x) => [x._id, x.n])), vd = new Map(visitsPerDay.map((x) => [x._id, x.n]));
  const series = Array.from({ length: 30 }, (_, i) => { const k = dayKey(new Date(since.getTime() + i * 86_400_000)); return { day: k, signups: pd.get(k) ?? 0, visitors: vd.get(k) ?? 0 }; });
  const top = sortRows(await referrerService.withStats(), "-signups").slice(0, 10).map((r) => ({ id: r.id, name: r.name, code: r.code, signups: r.stats.signups, sales: r.stats.sales, commission: r.stats.earned }));
  const lang = Object.fromEntries(langAgg.map((x) => [x._id, x.n]));
  ok(res, {
    siteMode: s.siteMode,
    cards: { totalMembers: total, newToday, newThisWeek: newWeek, referrers, activeReferrers, visitorsToday, totalSales: sales, commissionOwed: round2(owedAgg[0]?.n ?? 0), commissionPaid: round2(paidAgg[0]?.n ?? 0), payouts: paidAgg[0]?.c ?? 0 },
    signupsPerDay: series,
    languages: { en: lang.en ?? 0, es: lang.es ?? 0 },
    topReferrers: top,
    lastSignups: last,
  });
});
