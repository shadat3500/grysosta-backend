import { Router } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { ok, pageMeta } from "../../common/http";
import { idParams, objectId, pagination, validate } from "../../common/validate";
import { NotFound } from "../../common/errors";
import { sendExport } from "../../common/utils/export";
import { audit } from "../activity/activity.service";
import { Referrer } from "./referrer.model";
import { referrerService } from "./referrer.service";
import { Member } from "../members/member.model";
import { Sale } from "../sales/sales.models";
import { Payout } from "../payouts/payout.model";
import { emailService } from "../emails/email.service";
import { PAYOUT_METHODS } from "../payouts/payout.model";

type Row = Awaited<ReturnType<typeof referrerService.withStats>>[number];
const SORTS: Record<string, (r: Row) => number | string> = {
  name: (r) => r.name.toLowerCase(), code: (r) => r.code, status: (r) => r.status, etsy: (r) => Number(r.etsyCreated), createdAt: (r) => new Date(r.createdAt).getTime(),
  visits: (r) => r.stats.visits, signups: (r) => r.stats.signups, clicks: (r) => r.stats.clicks, sales: (r) => r.stats.sales,
  earned: (r) => r.stats.earned, paid: (r) => r.stats.paid, unpaid: (r) => r.stats.unpaid, ready: (r) => r.stats.ready,
};

const listSchema = pagination.extend({
  q: z.string().max(100).optional(),
  status: z.enum(["active", "paused", "blocked"]).optional(),
  etsyCreated: z.enum(["true", "false"]).optional(),
  format: z.enum(["json", "csv", "xlsx"]).default("json"),
});

export function sortRows(rows: Row[], sort = "-signups") {
  const desc = sort.startsWith("-");
  const f = SORTS[sort.replace(/^-/, "")] ?? SORTS.signups;
  return rows.sort((a, b) => { const x = f(a), y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * (desc ? -1 : 1); });
}

export const referrerRouter = Router();

/** A6 — table with all stats; sort by any column; search; filter by status & Etsy flag. */
referrerRouter.get("/", validate(listSchema, "query"), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listSchema>;
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.etsyCreated) filter.etsyCreated = q.etsyCreated === "true";
  let rows = await referrerService.withStats(filter);
  if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter((r) => `${r.name} ${r.email} ${r.code}`.toLowerCase().includes(s)); }
  sortRows(rows, q.sort);
  if (q.format !== "json") {
    return sendExport(res, rows.map((r) => ({ name: r.name, email: r.email, code: r.code, link: r.link, status: r.status, created_on_etsy: r.etsyCreated ? "yes" : "no", visits: r.stats.visits, signups: r.stats.signups, clicks: r.stats.clicks, sales: r.stats.sales, commission_earned: r.stats.earned, paid: r.stats.paid, unpaid: r.stats.unpaid, payout_email: r.payoutEmail })), "referrers", q.format);
  }
  ok(res, rows.slice((q.page - 1) * q.limit, q.page * q.limit), pageMeta(rows.length, q));
});

/** Detail page: stats, people referred, sales, payout history, notes. */
referrerRouter.get("/:id", validate(idParams, "params"), async (req, res) => {
  const [row] = await referrerService.withStats({ _id: new Types.ObjectId(String(req.params.id)) });
  if (!row) throw NotFound("Referrer");
  const [referred, sales, payouts] = await Promise.all([
    Member.find({ referredBy: row.id }, { firstName: 1, lastName: 1, email: 1, language: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(500).lean(),
    Sale.find({ referrerId: row.id }).sort({ saleDate: -1 }).limit(500).lean(),
    Payout.find({ referrerId: row.id }).sort({ paidOn: -1 }).lean(),
  ]);
  ok(res, { ...row, referred, sales, payouts });
});

const updateSchema = z.object({ notes: z.string().max(5000), payoutMethod: z.enum(PAYOUT_METHODS), payoutEmail: z.union([z.string().email(), z.literal("")]) }).partial().strict();
referrerRouter.patch("/:id", validate(idParams, "params"), validate(updateSchema), async (req, res) => {
  const r = await Referrer.findByIdAndUpdate(req.params.id, { $set: req.body }, { returnDocument: "after" }).lean();
  if (!r) throw NotFound("Referrer");
  await audit(req, req.body.notes !== undefined ? "Added note" : "Edited referrer", "referrers", String(r._id), Object.keys(req.body).join(", "));
  ok(res, r);
});

/** Activate · Pause · Block (SRS 6.6). */
referrerRouter.patch("/:id/status", validate(idParams, "params"), validate(z.object({ status: z.enum(["active", "paused", "blocked"]) })), async (req, res) => {
  const r = await Referrer.findByIdAndUpdate(req.params.id, { status: req.body.status }, { returnDocument: "after" }).lean();
  if (!r) throw NotFound("Referrer");
  await audit(req, `Set referrer ${req.body.status}`, "referrers", String(r._id), r.code);
  ok(res, r);
});

referrerRouter.patch("/:id/code", validate(idParams, "params"), validate(z.object({ code: z.string().min(4).max(20) })), async (req, res) => {
  const r = await referrerService.changeCode(String(req.params.id), req.body.code);
  await audit(req, "Edited referral code", "referrers", String(r._id), r.code);
  ok(res, r, { note: "Etsy flag was reset — create the new code on Etsy." });
});

referrerRouter.post("/:id/resend-email", validate(idParams, "params"), async (req, res) => {
  const r = await Referrer.findById(req.params.id).lean();
  const m = r?.memberId ? await Member.findById(r.memberId).lean() : null;
  if (!r || !m) throw NotFound("Referrer");
  await emailService.enqueueForMember("E2", m as never);
  await audit(req, "Resent referral email (E2)", "referrers", String(r._id));
  ok(res, { queued: true, to: m.email });
});

/* ---------------- A7 Etsy codes ---------------- */
export const etsyRouter = Router();

etsyRouter.get("/", validate(z.object({ created: z.enum(["true", "false"]).default("false") }), "query"), async (req, res) => {
  const created = (req.query as unknown as { created: string }).created === "true";
  const rows = await referrerService.withStats({ etsyCreated: created, status: { $ne: "blocked" } });
  sortRows(rows, "-signups"); // most active first
  ok(res, rows.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status, signups: r.stats.signups, etsyCreated: r.etsyCreated, etsyCreatedAt: r.etsyCreatedAt })), { notCreated: await Referrer.countDocuments({ etsyCreated: false, status: { $ne: "blocked" }, deletedMember: { $ne: true } }) });
});

/** Mark (bulk) as created / not created on Etsy. */
etsyRouter.post("/mark", validate(z.object({ ids: z.array(objectId).min(1).max(1000), created: z.boolean().default(true) })), async (req, res) => {
  const r = await Referrer.updateMany({ _id: { $in: req.body.ids } }, req.body.created ? { etsyCreated: true, etsyCreatedAt: new Date() } : { etsyCreated: false, etsyCreatedAt: null });
  await audit(req, req.body.created ? "Marked codes created on Etsy" : "Unmarked Etsy codes", "referrers", undefined, `${r.modifiedCount} code(s)`);
  ok(res, { updated: r.modifiedCount });
});
