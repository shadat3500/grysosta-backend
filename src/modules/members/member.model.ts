import { Schema, Types, model, type InferSchemaType } from "mongoose";

/** Client decision: three sign-up options, served in this priority order (1 = first). */
export const TIERS = ["prepay", "reserve", "vip"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_RANK: Record<Tier, number> = { prepay: 1, reserve: 2, vip: 3 };
export const TIER_LABEL: Record<Tier, string> = { prepay: "Prepay", reserve: "Reserve", vip: "VIP Priority List" };

/** Members stored before the tier field existed have no value → they count as VIP. */
export const tierQuery = (t: Tier) => (t === "vip" ? { $in: ["vip", null] } : t);

const memberSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    language: { type: String, enum: ["en", "es"], default: "en" },
    /** prepay = paid (or started Prepay), reserve = name + email, vip = free VIP list. */
    tier: { type: String, enum: TIERS, default: "vip", index: true },
    /** Set when the Stripe payment succeeds. */
    prepaidAt: { type: Date, default: null },
    /** Set when a purchase invitation e-mail was sent to this member (batch control). */
    invitedAt: { type: Date, default: null, index: true },
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
memberSchema.index({ tier: 1, invitedAt: 1, createdAt: 1 });
memberSchema.index({ firstName: "text", lastName: "text", email: "text" });

export type MemberDoc = InferSchemaType<typeof memberSchema> & { _id: Types.ObjectId };
export const Member = model("Member", memberSchema, "members");
