import { Router } from "express";
import { z } from "zod";
import { ok, pageMeta, sortSpec, created } from "../../common/http";
import { dateRange, idParams, objectId, pagination, rangeFilter, validate } from "../../common/validate";
import { BadRequest } from "../../common/errors";
import { csvUpload } from "../../common/upload";
import { sendExport } from "../../common/utils/export";
import { normalizeCode } from "../../common/utils/codes";
import { audit } from "../activity/activity.service";
import { Import, Sale } from "./sales.models";
import { IMPORT_FIELDS, salesService, type Mapping } from "./sales.service";

const fieldKeys = Object.keys(IMPORT_FIELDS) as [keyof typeof IMPORT_FIELDS, ...(keyof typeof IMPORT_FIELDS)[]];
const mappingSchema = z.partialRecord(z.enum(fieldKeys), z.string().max(200));
const parseMapping = (v: unknown): Mapping | undefined => {
  if (!v) return undefined;
  const r = mappingSchema.safeParse(typeof v === "string" ? JSON.parse(v) : v);
  if (!r.success) throw BadRequest("Invalid column mapping");
  return r.data as Mapping;
};

export const salesRouter = Router();

/** A8 step 1 — multipart `file` (Etsy Orders / Order Items CSV, max 10 MB) [+ optional `mapping` JSON]. */
salesRouter.post("/import/preview", csvUpload.single("file"), async (req, res) => {
  if (!req.file) throw BadRequest("Upload the CSV as multipart field 'file'");
  ok(res, await salesService.preview(req.file, req.admin!._id, parseMapping(req.body?.mapping)), { expectedColumns: IMPORT_FIELDS });
});

/** Mapping screen: re-analyze the same upload with other columns. */
salesRouter.post("/import/:draftId/analyze", validate(z.object({ draftId: objectId }), "params"), validate(z.object({ mapping: mappingSchema })), async (req, res) => {
  ok(res, await salesService.analyzeDraft(String(req.params.draftId), req.body.mapping as Mapping));
});

/** Step 2 — confirm. assignments: { UNKNOWNCODE: referrerId | "skip" | null }. */
const confirmSchema = z.object({ mapping: mappingSchema.optional(), assignments: z.record(z.string(), z.union([objectId, z.literal("skip"), z.null()])).default({}) });
salesRouter.post("/import/:draftId/confirm", validate(z.object({ draftId: objectId }), "params"), validate(confirmSchema), async (req, res) => {
  const assignments = Object.fromEntries(Object.entries(req.body.assignments as Record<string, string | null>).map(([k, v]) => [normalizeCode(k), v]));
  const r = await salesService.confirm(String(req.params.draftId), req.body.mapping as Mapping | undefined, assignments, req.admin?.name ?? "admin");
  await audit(req, "Imported sales CSV", "imports", String(r._id), `${r.rowsAdded} added, ${r.rowsSkipped} skipped`);
  created(res, r);
});

/** Import history + undo last import. */
salesRouter.get("/imports", validate(pagination, "query"), async (req, res) => {
  const q = req.query as unknown as { page: number; limit: number };
  const [items, total] = await Promise.all([Import.find().sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Import.countDocuments()]);
  ok(res, items, pageMeta(total, q));
});

salesRouter.post("/imports/undo-last", async (req, res) => {
  const r = await salesService.undoLast();
  await audit(req, "Undid import", "imports", String(r.importId), `${r.removed} sales removed`);
  ok(res, r);
});

/** Add sale manually: date, order ID, code, amount, quantity, platform, note. */
const manualSchema = z.object({
  saleDate: z.string().date(), orderId: z.string().trim().min(1).max(60), code: z.string().max(30).optional().default(""),
  amount: z.number().positive(), quantity: z.number().int().min(1).default(1), platform: z.enum(["etsy", "manual"]).default("etsy"), note: z.string().max(1000).optional(),
});
salesRouter.post("/manual", validate(manualSchema), async (req, res) => {
  const sale = await salesService.addManual(req.body);
  await audit(req, "Added manual sale", "sales", String(sale?._id), req.body.orderId);
  created(res, sale);
});

/** All sales & commission status (filters + export). */
const listSchema = pagination.merge(dateRange).extend({
  q: z.string().max(60).optional(),
  status: z.enum(["pending", "approved", "paid", "cancelled"]).optional(),
  referrerId: objectId.optional(),
  hasReferrer: z.enum(["true", "false"]).optional(),
  refunded: z.enum(["true", "false"]).optional(),
  format: z.enum(["json", "csv", "xlsx"]).default("json"),
});
salesRouter.get("/", validate(listSchema, "query"), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listSchema>;
  const f: Record<string, unknown> = {};
  if (q.q) f.$or = [{ orderId: q.q.trim() }, { couponCode: normalizeCode(q.q) }];
  if (q.status) f.commissionStatus = q.status;
  if (q.referrerId) f.referrerId = q.referrerId;
  if (q.hasReferrer) f.referrerId = q.hasReferrer === "true" ? { $ne: null } : null;
  if (q.refunded) f.refunded = q.refunded === "true";
  const r = rangeFilter(q.from, q.to);
  if (r) f.saleDate = r;
  if (q.format !== "json") {
    const rows = await Sale.find(f).sort({ saleDate: -1 }).populate("referrerId", "code").lean();
    return sendExport(res, rows.map((s) => ({ order_id: s.orderId, platform: s.platform, sale_date: s.saleDate.toISOString(), coupon_code: s.couponCode, referrer: (s.referrerId as unknown as { code?: string } | null)?.code ?? "", quantity: s.quantity, order_value: s.orderValue, discount: s.discount, base_amount: s.baseAmount, commission_percent: s.commissionPercent, commission_amount: s.commissionAmount, commission_status: s.commissionStatus, refunded: s.refunded ? "yes" : "no" })), "sales", q.format);
  }
  const sort = sortSpec(q.sort, ["saleDate", "orderId", "couponCode", "baseAmount", "commissionAmount", "commissionStatus"], { saleDate: -1 });
  const [items, total] = await Promise.all([Sale.find(f).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).populate("referrerId", "code").lean(), Sale.countDocuments(f)]);
  ok(res, items, pageMeta(total, q));
});

salesRouter.post("/:id/refund", validate(idParams, "params"), async (req, res) => {
  const s = await salesService.refund(String(req.params.id));
  await audit(req, "Marked sale refunded", "sales", String(s._id), s.orderId);
  ok(res, s, s.clawbackOpen ? { note: "Commission was already paid — it will be deducted from the next payout." } : undefined);
});

salesRouter.post("/approve-due", async (req, res) => {
  const n = await salesService.approveDue();
  await audit(req, "Ran commission approval", "sales", undefined, `${n} approved`);
  ok(res, { approved: n });
});
