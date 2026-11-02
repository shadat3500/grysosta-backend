import { Schema, Types, model, type InferSchemaType } from "mongoose";

const saleSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["etsy", "manual"], default: "etsy" },
    saleDate: { type: Date, required: true },
    couponCode: { type: String, default: "", index: true },
    referrerId: { type: Types.ObjectId, ref: "Referrer", default: null, index: true },
    quantity: { type: Number, default: 1 },
    orderValue: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    baseAmount: { type: Number, default: 0 },
    commissionPercent: { type: Number, default: 0 },
    commissionAmount: { type: Number, default: 0 },
    commissionStatus: { type: String, enum: ["pending", "approved", "paid", "cancelled"], default: "pending", index: true },
    refunded: { type: Boolean, default: false },
    refundedAt: { type: Date, default: null },
    /** Refund after payout → negative balance deducted from the next payout (SRS 9.4). */
    clawbackOpen: { type: Boolean, default: false },
    flagged: { type: String, default: "" },
    importId: { type: Types.ObjectId, ref: "Import", default: null, index: true },
    payoutId: { type: Types.ObjectId, ref: "Payout", default: null },
    buyerName: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);
saleSchema.index({ referrerId: 1, commissionStatus: 1 });
saleSchema.index({ saleDate: -1 });

export type SaleDoc = InferSchemaType<typeof saleSchema> & { _id: Types.ObjectId };
export const Sale = model("Sale", saleSchema, "sales");

const importSchema = new Schema(
  {
    fileName: { type: String, required: true },
    rowsTotal: { type: Number, default: 0 },
    rowsAdded: { type: Number, default: 0 },
    rowsSkipped: { type: Number, default: 0 },
    rowsUnknownCode: { type: Number, default: 0 },
    importedBy: { type: String, default: "" },
    undone: { type: Boolean, default: false },
    undoneAt: { type: Date, default: null },
  },
  { timestamps: true },
);
importSchema.index({ createdAt: -1 });
export const Import = model("Import", importSchema, "imports");

/** Parsed CSV kept between "preview" and "confirm" (expires after 1 hour). */
const draftSchema = new Schema(
  {
    fileName: String,
    headers: [String],
    rows: { type: [Schema.Types.Mixed], default: [] },
    adminId: { type: Types.ObjectId },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 3_600_000) },
  },
  { timestamps: true },
);
draftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ImportDraft = model("ImportDraft", draftSchema, "import_drafts");
