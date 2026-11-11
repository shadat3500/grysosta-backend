import { Schema, Types, model, type InferSchemaType } from "mongoose";

export const ORDER_STATUSES = ["pending", "paid", "refunded", "expired"] as const;

/** One Prepay purchase on GRYSOSTA.com (Stripe Checkout). Money is stored in dollars. */
const orderSchema = new Schema(
  {
    memberId: { type: Types.ObjectId, ref: "Member", default: null, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    language: { type: String, enum: ["en", "es"], default: "en" },
    regularPrice: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    /** Amount charged (VIP prepay price, 10% off). */
    amount: { type: Number, required: true },
    currency: { type: String, default: "usd" },
    status: { type: String, enum: ORDER_STATUSES, default: "pending", index: true },
    stripeSessionId: { type: String, index: { unique: true, sparse: true } },
    stripePaymentIntentId: { type: String, default: "", index: true },
    referrerId: { type: Types.ObjectId, ref: "Referrer", default: null, index: true },
    referrerCode: { type: String, default: "" },
    saleId: { type: Types.ObjectId, ref: "Sale", default: null },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
orderSchema.index({ createdAt: -1 });

export type OrderDoc = InferSchemaType<typeof orderSchema> & { _id: Types.ObjectId };
export const Order = model("Order", orderSchema, "orders");
