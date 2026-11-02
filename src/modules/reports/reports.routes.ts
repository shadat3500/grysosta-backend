import { Router } from "express";
import { z } from "zod";
import { ok, pageMeta } from "../../common/http";
import { dateRange, langEnum, pagination, rangeFilter, validate } from "../../common/validate";
import { sendExport } from "../../common/utils/export";
import { escapeRegex } from "../../common/utils/regex";
import { Member } from "../members/member.model";
import { memberService } from "../members/member.service";
import { referrerService } from "../referrers/referrer.service";
import { Sale } from "../sales/sales.models";
import { Payout } from "../payouts/payout.model";
import { Activity } from "../activity/activity.model";

const filters = dateRange.extend({ lang: langEnum.optional() });
const exportSchema = filters.extend({ format: z.enum(["csv", "xlsx"]).default("csv") });
const DATASETS = ["members", "referrers", "sales", "commissions", "payouts", "activity"] as const;

export const reportsRouter = Router();

/** A13 — export VIP members, referrers, sales, commissions, payouts, activity log (date range + language). */
reportsRouter.get("/export/:dataset", validate(z.object({ dataset: z.enum(DATASETS) }), "params"), validate(exportSchema, "query"), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof exportSchema>;
  const range = rangeFilter(q.from, q.to);
  const ds = req.params.dataset as (typeof DATASETS)[number];
  let rows: Record<string, unknown>[] = [];
  if (ds === "members") rows = await memberService.exportRows({ ...(range ? { createdAt: range } : {}), ...(q.lang ? { language: q.lang } : {}) });
  if (ds === "referrers") {
    const list = await referrerService.withStats(range ? { createdAt: range } : {});
    rows = list.filter((r) => !q.lang || r.language === q.lang).map((r) => ({ name: r.name, email: r.email, language: r.language, code: r.code, status: r.status, etsy_created: r.etsyCreated ? "yes" : "no", visits: r.stats.visits, signups: r.stats.signups, clicks: r.stats.clicks, sales: r.stats.sales, earned: r.stats.earned, paid: r.stats.paid, unpaid: r.stats.unpaid }));
  }
  if (ds === "sales" || ds === "commissions") {
    const f: Record<string, unknown> = range ? { saleDate: range } : {};
    if (ds === "commissions") f.referrerId = { $ne: null };
    const list = await Sale.find(f).sort({ saleDate: -1 }).populate("referrerId", "code").lean();
    rows = list.map((s) => ({ order_id: s.orderId, sale_date: s.saleDate.toISOString(), platform: s.platform, coupon_code: s.couponCode, referrer: (s.referrerId as unknown as { code?: string } | null)?.code ?? "", quantity: s.quantity, order_value: s.orderValue, discount: s.discount, base_amount: s.baseAmount, commission_percent: s.commissionPercent, commission_amount: s.commissionAmount, status: s.commissionStatus, refunded: s.refunded ? "yes" : "no" }));
  }
  if (ds === "payouts") {
    const list = await Payout.find(range ? { paidOn: range } : {}).sort({ paidOn: -1 }).populate("referrerId", "code").lean();
    rows = list.map((p) => ({ date: p.paidOn.toISOString().slice(0, 10), referrer: (p.referrerId as unknown as { code?: string })?.code ?? "", amount: p.amount, method: p.method, transaction_id: p.transactionId, note: p.note }));
  }
  if (ds === "activity") {
    const list = await Activity.find(range ? { createdAt: range } : {}).sort({ createdAt: -1 }).limit(50_000).lean();
    rows = list.map((a) => ({ date: (a as unknown as { createdAt: Date }).createdAt.toISOString(), admin: a.adminName, action: a.action, entity: a.entity, entity_id: a.entityId ?? "", details: a.details }));
  }
  sendExport(res, rows, ds, q.format);
});

/** Signups by source (UTM) — measures Facebook ads, flyers, referrals. */
reportsRouter.get("/signups-by-source", validate(filters, "query"), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof filters>;
  const match: Record<string, unknown> = {};
  const range = rangeFilter(q.from, q.to);
  if (range) match.createdAt = range;
  if (q.lang) match.language = q.lang;
  const rows = await Member.aggregate([
    { $match: match },
    { $group: { _id: { source: { $ifNull: ["$utmSource", "direct"] }, medium: "$utmMedium", campaign: "$utmCampaign" }, signups: { $sum: 1 }, referrers: { $sum: { $cond: ["$isReferrer", 1, 0] } } } },
    { $sort: { signups: -1 } },
  ]);
  ok(res, rows.map((r) => ({ source: r._id.source, medium: r._id.medium ?? null, campaign: r._id.campaign ?? null, signups: r.signups, referrers: r.referrers })));
});

/** Activity log (who, what, when). */
export const activityRouter = Router();
activityRouter.get("/", validate(pagination.merge(dateRange).extend({ q: z.string().max(100).optional(), entity: z.string().max(40).optional() }), "query"), async (req, res) => {
  const q = req.query as unknown as { page: number; limit: number; from?: string; to?: string; q?: string; entity?: string };
  const f: Record<string, unknown> = {};
  if (q.entity) f.entity = q.entity;
  if (q.q) { const rx = new RegExp(escapeRegex(q.q), "i"); f.$or = [{ action: rx }, { details: rx }, { entity: rx }]; }
  const r = rangeFilter(q.from, q.to);
  if (r) f.createdAt = r;
  const [items, total] = await Promise.all([Activity.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Activity.countDocuments(f)]);
  ok(res, items, pageMeta(total, q));
});
