import { Router } from "express";
import { z } from "zod";
import { ok, pageMeta, created } from "../../common/http";
import { dateRange, objectId, pagination, rangeFilter, validate } from "../../common/validate";
import { sendExport } from "../../common/utils/export";
import { round2 } from "../../common/utils/money";
import { audit } from "../activity/activity.service";
import { PAYOUT_METHODS, Payout, PayoutSale } from "./payout.model";
import { payoutService } from "./payout.service";
import { referrerService } from "../referrers/referrer.service";
import { sortRows } from "../referrers/referrer.routes";
import { settingsService } from "../settings/settings.service";
import { Sale } from "../sales/sales.models";

export const payoutRouter = Router();

/** A9 — per referrer: sales count, sales total, commission, paid, unpaid, ready to pay. */
payoutRouter.get("/summary", validate(pagination.extend({ q: z.string().max(60).optional(), readyOnly: z.enum(["true", "false"]).optional() }), "query"), async (req, res) => {
  const q = req.query as unknown as { page: number; limit: number; sort?: string; q?: string; readyOnly?: string };
  const s = await settingsService.get();
  let rows = (await referrerService.withStats()).filter((r) => r.stats.sales > 0 || r.stats.paid > 0 || r.stats.clawback > 0);
  if (q.q) rows = rows.filter((r) => `${r.name} ${r.code}`.toLowerCase().includes(q.q!.toLowerCase()));
  const mapped = rows.map((r) => ({ ...r, readyToPay: r.status !== "blocked" && r.stats.ready >= s.minPayout }));
  const filtered = q.readyOnly === "true" ? mapped.filter((r) => r.readyToPay) : mapped;
  sortRows(filtered, q.sort ?? "-ready");
  const sum = async (status: string) => round2((await Sale.aggregate([{ $match: { commissionStatus: status } }, { $group: { _id: null, n: { $sum: "$commissionAmount" } } }]))[0]?.n ?? 0);
  const totals = { pending: await sum("pending"), approved: await sum("approved"), paid: round2((await Payout.aggregate([{ $group: { _id: null, n: { $sum: "$amount" } } }]))[0]?.n ?? 0), readyCount: mapped.filter((r) => r.readyToPay).length, minPayout: s.minPayout };
  ok(res, filtered.slice((q.page - 1) * q.limit, q.page * q.limit), { ...pageMeta(filtered.length, q), totals });
});

const recordSchema = z.object({ referrerId: objectId, amount: z.number().positive(), paidOn: z.string().date(), method: z.enum(PAYOUT_METHODS).default("PayPal"), transactionId: z.string().max(120).optional(), note: z.string().max(1000).optional() });
payoutRouter.post("/", validate(recordSchema), async (req, res) => {
  const p = await payoutService.record(req.body, req.admin?.name ?? "admin");
  await audit(req, "Recorded payout", "payouts", String(p._id), `$${p.amount.toFixed(2)} via ${p.method}`);
  created(res, p);
});

payoutRouter.get("/", validate(pagination.merge(dateRange).extend({ referrerId: objectId.optional(), format: z.enum(["json", "csv", "xlsx"]).default("json") }), "query"), async (req, res) => {
  const q = req.query as unknown as { page: number; limit: number; from?: string; to?: string; referrerId?: string; format: string };
  const f: Record<string, unknown> = {};
  if (q.referrerId) f.referrerId = q.referrerId;
  const r = rangeFilter(q.from, q.to);
  if (r) f.paidOn = r;
  if (q.format !== "json") {
    const rows = await Payout.find(f).sort({ paidOn: -1 }).populate("referrerId", "code").lean();
    return sendExport(res, rows.map((p) => ({ date: p.paidOn.toISOString().slice(0, 10), referrer: (p.referrerId as unknown as { code?: string })?.code ?? "", amount: p.amount, method: p.method, transaction_id: p.transactionId, note: p.note, created_by: p.createdBy })), "payouts", q.format as "csv");
  }
  const [items, total] = await Promise.all([Payout.find(f).sort({ paidOn: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate("referrerId", "code").lean(), Payout.countDocuments(f)]);
  const counts = new Map((await PayoutSale.aggregate([{ $match: { payoutId: { $in: items.map((p) => p._id) } } }, { $group: { _id: "$payoutId", n: { $sum: 1 } } }])).map((x) => [String(x._id), x.n]));
  ok(res, items.map((p) => ({ ...p, salesCovered: counts.get(String(p._id)) ?? 0 })), pageMeta(total, q));
});

/** CSV for PayPal bulk payment (everyone ready to pay). */
payoutRouter.get("/paypal-export", async (_req, res) => {
  const s = await settingsService.get();
  const rows = (await referrerService.withStats()).filter((r) => r.status !== "blocked" && r.stats.ready >= s.minPayout);
  sendExport(res, rows.map((r) => ({ "Recipient email": r.payoutEmail || r.email, Amount: r.stats.ready.toFixed(2), Currency: "USD", "Recipient ID": r.code, Note: "GRYSOSTA referral commission" })), "paypal-bulk-payouts", "csv");
});
