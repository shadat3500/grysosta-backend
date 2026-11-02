import { Schema, Types, model, type InferSchemaType } from "mongoose";

const memberSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    language: { type: String, enum: ["en", "es"], default: "en" },
    isReferrer: { type: Boolean, default: false },
    referredBy: { type: Types.ObjectId, ref: "Referrer", default: null, index: true },
    status: { type: String, enum: ["subscribed", "unsubscribed"], default: "subscribed", index: true },
    unsubscribeToken: { type: String, required: true, unique: true },
    consentAt: { type: Date, required: true },
    unsubscribedAt: { type: Date, default: null },
    ipCountry: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    visitorHash: { type: String, default: "" },
    utmSource: { type: String, default: null },
    utmMedium: { type: String, default: null },
    utmCampaign: { type: String, default: null },
    lastWelcomeAt: { type: Date, default: null },
  },
  { timestamps: true },
);
memberSchema.index({ createdAt: -1 });
memberSchema.index({ language: 1, createdAt: -1 });
memberSchema.index({ utmSource: 1 });
memberSchema.index({ firstName: "text", lastName: "text", email: "text" });

export type MemberDoc = InferSchemaType<typeof memberSchema> & { _id: Types.ObjectId };
export const Member = model("Member", memberSchema, "members");
