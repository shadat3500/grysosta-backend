import Papa from "papaparse";
import { Types } from "mongoose";
import { Import, ImportDraft, Sale } from "./sales.models";
import { calcCommission } from "./commission";
import { Referrer } from "../referrers/referrer.model";
import { settingsService } from "../settings/settings.service";
import { normalizeCode } from "../../common/utils/codes";
import { parseMoney } from "../../common/utils/money";
import { parseEtsyDate } from "../../common/utils/dates";
import { BadRequest, Conflict, NotFound } from "../../common/errors";

/** SRS 9.1 expected Etsy columns; the mapping screen handles different names. */
export const IMPORT_FIELDS = {
  orderId: ["Order ID", "Order Id", "order_id"],
  saleDate: ["Sale Date", "Date", "Order Date"],
  couponCode: ["Coupon Code", "Coupon", "Promo Code"],
  quantity: ["Number of Items", "Quantity", "Qty"],
  orderValue: ["Order Value", "Item Total", "Price"],
  discount: ["Discount Amount", "Discount", "Coupon Discount"],
  orderTotal: ["Order Total"],
  orderNet: ["Order Net"],
  buyerName: ["Full Name", "Buyer", "Name"],
} as const;
export type FieldKey = keyof typeof IMPORT_FIELDS;
export type Mapping = Partial<Record<FieldKey, string>>;
const REQUIRED: FieldKey[] = ["orderId", "saleDate", "orderValue"];

export function autoMap(headers: string[]): Mapping {
  const m: Mapping = {};
  for (const [k, names] of Object.entries(IMPORT_FIELDS) as [FieldKey, readonly string[]][]) {
    const h = headers.find((x) => names.some((n) => n.toLowerCase() === x.trim().toLowerCase()));
    if (h) m[k] = h;
  }
  return m;
}

interface Row { orderId: string; saleDate: Date; couponCode: string; quantity: number; orderValue: number; discount: number; buyerName: string }
type Kind = "known" | "general" | "none" | "unknown" | "duplicate" | "invalid";

function mapRows(raw: Record<string, string>[], m: Mapping): (Row & { error?: string })[] {
  return raw.map((r) => {
    const d = parseEtsyDate(r[m.saleDate!] ?? "");
    return {
      orderId: String(r[m.orderId!] ?? "").trim(),
      saleDate: d ?? new Date(NaN),
      couponCode: m.couponCode ? normalizeCode(r[m.couponCode] ?? "") : "",
      quantity: Math.max(1, Math.round(parseMoney(m.quantity ? r[m.quantity] : 1)) || 1),
      orderValue: parseMoney(r[m.orderValue!]),
      discount: Math.abs(parseMoney(m.discount ? r[m.discount] : 0)),
      buyerName: m.buyerName ? String(r[m.buyerName] ?? "").slice(0, 100) : "",
      error: !String(r[m.orderId!] ?? "").trim() ? "Missing Order ID" : !d ? "Invalid date" : undefined,
    };
  });
}

async function analyze(rows: (Row & { error?: string })[]) {
  const s = await settingsService.get();
  const ids = rows.map((r) => r.orderId).filter(Boolean);
  const existing = new Set((await Sale.find({ orderId: { $in: ids } }, { orderId: 1 }).lean()).map((x) => x.orderId));
  const codes = [...new Set(rows.map((r) => r.couponCode).filter(Boolean))];
  const refs = new Map((await Referrer.find({ code: { $in: codes } }, { code: 1, status: 1 }).lean()).map((r) => [r.code, r]));
  const seen = new Set<string>();
  const out = rows.map((r) => {
    let kind: Kind;
    if (r.error) kind = "invalid";
    else if (existing.has(r.orderId) || seen.has(r.orderId)) kind = "duplicate";
    else if (!r.couponCode) kind = "none";
    else if (r.couponCode === s.generalVipCode) kind = "general";
    else if (refs.has(r.couponCode)) kind = "known";
    else kind = "unknown";
    seen.add(r.orderId);
    const ref = refs.get(r.couponCode);
    const commission = kind === "known" && ref?.status === "active" ? calcCommission(r.orderValue, r.discount, s).amount : 0;
    return { ...r, kind, referrerId: ref?._id ?? null, referrerCode: ref?.code ?? null, referrerStatus: ref?.status ?? null, commission };
  });
  const count = (k: Kind) => out.filter((r) => r.kind === k).length;
  return {
    rows: out,
    summary: {
      rowsFound: out.length, knownCode: count("known"), generalCode: count("general"), noCode: count("none"), unknownCode: count("unknown"),
      duplicates: count("duplicate"), invalid: count("invalid"),
      commissionTotal: Math.round(out.reduce((a, r) => a + r.commission, 0) * 100) / 100,
      commissionPercent: s.commissionPercent,
    },
    unknownCodes: [...new Set(out.filter((r) => r.kind === "unknown").map((r) => r.couponCode))],
  };
}

export const salesService = {
  /** Step 1: upload → parse on server → draft (expires 1 h) → preview + suggested mapping. */
  async preview(file: { originalname: string; buffer: Buffer }, adminId: Types.ObjectId, mapping?: Mapping) {
    const text = file.buffer.toString("utf8").replace(/^﻿/, "");
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
    const headers = parsed.meta.fields ?? [];
    if (!headers.length || !parsed.data.length) throw BadRequest("The CSV is empty or has no header row");
    if (parsed.data.length > 50_000) throw BadRequest("Too many rows in one file (max 50,000)");
    const draft = await ImportDraft.create({ fileName: file.originalname, headers, rows: parsed.data, adminId });
    return this.analyzeDraft(String(draft._id), mapping);
  },

  /** Re-run with a different column mapping (mapping screen). */
  async analyzeDraft(draftId: string, mapping?: Mapping) {
    const d = await ImportDraft.findById(draftId).lean();
    if (!d) throw NotFound("Import preview (it expires after 1 hour)");
    const m = { ...autoMap(d.headers as string[]), ...(mapping ?? {}) };
    const missing = REQUIRED.filter((k) => !m[k]);
    if (missing.length) return { draftId, fileName: d.fileName, headers: d.headers, mapping: m, needsMapping: true, missing, summary: null, rows: [], unknownCodes: [] };
    const a = await analyze(mapRows(d.rows as Record<string, string>[], m));
    return { draftId, fileName: d.fileName, headers: d.headers, mapping: m, needsMapping: false, missing: [], ...a };
  },

  /** Step 2: confirm → save sales + commission (status Pending). assignments: unknown code → referrerId | "skip" | null (no referrer). */
  async confirm(draftId: string, mapping: Mapping | undefined, assignments: Record<string, string | null>, importedBy: string) {
    const res = await this.analyzeDraft(draftId, mapping);
    if (res.needsMapping) throw BadRequest("Map the required columns first", { missing: res.missing });
    const s = await settingsService.get();
    const assignIds = Object.values(assignments).filter((v): v is string => !!v && v !== "skip");
    const assigned = new Map((await Referrer.find({ _id: { $in: assignIds } }).lean()).map((r) => [String(r._id), r]));
    const imp = await Import.create({ fileName: String(res.fileName ?? "upload.csv"), rowsTotal: res.rows.length, rowsUnknownCode: res.summary!.unknownCode, importedBy });
    const docs: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const r of res.rows) {
      if (r.kind === "duplicate" || r.kind === "invalid") { skipped++; continue; }
      let referrerId: Types.ObjectId | null = null;
      let status: string | null = null;
      if (r.kind === "known") { referrerId = r.referrerId as Types.ObjectId; status = r.referrerStatus; }
      if (r.kind === "unknown") {
        const a = assignments[r.couponCode];
        if (a === "skip") { skipped++; continue; }
        const ref = a ? assigned.get(a) : undefined;
        if (ref) { referrerId = ref._id; status = ref.status; }
      }
      const { base, amount } = calcCommission(r.orderValue, r.discount, s);
      const active = status === "active";
      docs.push({
        orderId: r.orderId, platform: "etsy", saleDate: r.saleDate, couponCode: r.couponCode, referrerId, quantity: r.quantity,
        orderValue: r.orderValue, discount: r.discount, baseAmount: base,
        commissionPercent: s.commissionPercent, // % saved per sale (SRS A12 rule)
        commissionAmount: referrerId && active ? amount : 0,
        commissionStatus: referrerId && active ? "pending" : "cancelled",
        flagged: referrerId && !active ? `Referrer ${status} — commission $0` : "",
        importId: imp._id, buyerName: r.buyerName,
      });
    }
    let added = 0;
    for (let i = 0; i < docs.length; i += 1000) {
      try {
        const ins = await Sale.insertMany(docs.slice(i, i + 1000), { ordered: false });
        added += ins.length;
      } catch (e) {
        const inserted = (e as { insertedDocs?: unknown[] }).insertedDocs?.length ?? 0; // concurrent duplicate order IDs are skipped
        added += inserted;
        skipped += docs.slice(i, i + 1000).length - inserted;
      }
    }
    await Import.updateOne({ _id: imp._id }, { rowsAdded: added, rowsSkipped: skipped });
    await ImportDraft.deleteOne({ _id: draftId });
    await this.approveDue();
    return { ...(await Import.findById(imp._id).lean()), summary: res.summary };
  },

  /** Undo last import — only if none of its commissions were paid yet. */
  async undoLast() {
    const last = await Import.findOne({ undone: false }).sort({ createdAt: -1 });
    if (!last) throw NotFound("Import");
    if (await Sale.exists({ importId: last._id, commissionStatus: "paid" })) throw Conflict("Some commissions from this import are already paid — record refunds instead");
    const r = await Sale.deleteMany({ importId: last._id });
    last.undone = true;
    last.undoneAt = new Date();
    await last.save();
    return { importId: last._id, removed: r.deletedCount };
  },

  async addManual(i: { saleDate: string; orderId: string; code?: string; amount: number; quantity: number; platform: "etsy" | "manual"; note?: string }) {
    if (await Sale.exists({ orderId: i.orderId })) throw Conflict("This order ID already exists");
    const s = await settingsService.get();
    const code = normalizeCode(i.code ?? "");
    const ref = code && code !== s.generalVipCode ? await Referrer.findOne({ code }).lean() : null;
    if (code && code !== s.generalVipCode && !ref) throw BadRequest("Unknown code");
    // `amount` is what the buyer paid (after discount); rebuild the original value when a code was used.
    const discount = code ? Math.round(i.amount * (s.discountPercent / (100 - s.discountPercent)) * 100) / 100 : 0;
    const orderValue = Math.round((i.amount + discount) * 100) / 100;
    const { base, amount } = calcCommission(orderValue, discount, s);
    const active = ref?.status === "active";
    const sale = await Sale.create({
      orderId: i.orderId, platform: i.platform, saleDate: new Date(i.saleDate), couponCode: code, referrerId: ref?._id ?? null, quantity: i.quantity,
      orderValue, discount, baseAmount: base, commissionPercent: s.commissionPercent, commissionAmount: active ? amount : 0,
      commissionStatus: active ? "pending" : "cancelled", flagged: ref && !active ? `Referrer ${ref.status} — commission $0` : "", note: i.note ?? "",
    });
    await this.approveDue();
    return Sale.findById(sale._id).lean();
  },

  /** SRS 9.4 — refunded → Cancelled; if already paid → negative balance for the next payout. */
  async refund(id: string) {
    const s = await Sale.findById(id);
    if (!s) throw NotFound("Sale");
    if (s.refunded) throw BadRequest("Sale is already refunded");
    s.clawbackOpen = s.commissionStatus === "paid" && s.commissionAmount > 0;
    s.refunded = true;
    s.refundedAt = new Date();
    s.commissionStatus = "cancelled";
    await s.save();
    return s.toObject();
  },

  /** Daily job: Pending → Approved after the holding period (SRS 9.2). */
  async approveDue() {
    const s = await settingsService.get();
    const cutoff = new Date(Date.now() - s.holdingDays * 86_400_000);
    const r = await Sale.updateMany({ commissionStatus: "pending", saleDate: { $lte: cutoff } }, { commissionStatus: "approved" });
    return r.modifiedCount;
  },
};
