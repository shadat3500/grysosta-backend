import { Schema, Types, model } from "mongoose";

export const PAYOUT_METHODS = ["PayPal", "Zelle", "Cash App", "Bank", "Other"] as const;

const payoutSchema = new Schema(
  {
    referrerId: { type: Types.ObjectId, ref: "Referrer", required: true, index: true },
    amount: { type: Number, required: true },
    paidOn: { type: Date, required: true },
    method: { type: String, enum: PAYOUT_METHODS, default: "PayPal" },
    transactionId: { type: String, default: "" },
    note: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);
payoutSchema.index({ paidOn: -1 });
export const Payout = model("Payout", payoutSchema, "payouts");

/** SRS 10 payout_sales — which sales a payout covered. */
const payoutSaleSchema = new Schema({ payoutId: { type: Types.ObjectId, required: true, index: true }, saleId: { type: Types.ObjectId, required: true, index: true } }, { timestamps: false });
export const PayoutSale = model("PayoutSale", payoutSaleSchema, "payout_sales");
