import { Schema, Types, model } from "mongoose";

/** One per referrer per visitor per day (SRS 6.5). */
const referralVisitSchema = new Schema(
  {
    referrerId: { type: Types.ObjectId, ref: "Referrer", required: true, index: true },
    visitorHash: { type: String, required: true },
    visitedOn: { type: String, required: true }, // YYYY-MM-DD
    landingLang: { type: String, enum: ["en", "es"], default: "en" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
referralVisitSchema.index({ referrerId: 1, visitorHash: 1, visitedOn: 1 }, { unique: true });
export const ReferralVisit = model("ReferralVisit", referralVisitSchema, "referral_visits");

const pageVisitSchema = new Schema(
  {
    visitorHash: { type: String, required: true },
    visitedOn: { type: String, required: true },
    lang: { type: String, enum: ["en", "es"], default: "en" },
    utmSource: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
pageVisitSchema.index({ visitorHash: 1, visitedOn: 1 }, { unique: true });
pageVisitSchema.index({ visitedOn: 1 });
export const PageVisit = model("PageVisit", pageVisitSchema, "page_visits");

const buyClickSchema = new Schema(
  {
    referrerId: { type: Types.ObjectId, ref: "Referrer", default: null, index: true },
    lang: { type: String, enum: ["en", "es"], default: "en" },
    codeShown: { type: String, default: "" },
    clickedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
buyClickSchema.index({ clickedAt: -1 });
export const BuyClick = model("BuyClick", buyClickSchema, "buy_clicks");
