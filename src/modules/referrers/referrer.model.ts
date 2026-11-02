import { Schema, Types, model, type InferSchemaType } from "mongoose";

const referrerSchema = new Schema(
  {
    memberId: { type: Types.ObjectId, ref: "Member", default: null },
    code: { type: String, required: true, unique: true, uppercase: true },
    status: { type: String, enum: ["active", "paused", "blocked"], default: "active", index: true },
    etsyCreated: { type: Boolean, default: false, index: true },
    etsyCreatedAt: { type: Date, default: null },
    payoutMethod: { type: String, default: "PayPal" },
    payoutEmail: { type: String, default: "" },
    notes: { type: String, default: "" },
    visits: { type: Number, default: 0 },
    deletedMember: { type: Boolean, default: false },
  },
  { timestamps: true },
);

referrerSchema.index({ memberId: 1 }, { unique: true, partialFilterExpression: { memberId: { $type: "objectId" } } });

export type ReferrerDoc = InferSchemaType<typeof referrerSchema> & { _id: Types.ObjectId };
export const Referrer = model("Referrer", referrerSchema, "referrers");

/** Codes are never reused after deletion (SRS 6.3). */
const retiredSchema = new Schema({ code: { type: String, required: true, unique: true } }, { timestamps: { createdAt: true, updatedAt: false } });
export const RetiredCode = model("RetiredCode", retiredSchema, "retired_codes");
