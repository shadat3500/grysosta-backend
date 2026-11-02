import { Schema, model } from "mongoose";

const bilingual = { en: { type: String, default: "" }, es: { type: String, default: "" } };

const faqSchema = new Schema({ qEn: String, qEs: { type: String, default: "" }, aEn: String, aEs: { type: String, default: "" } }, { _id: true });

/** SRS 10 site_content — editable texts, FAQ list, policy pages and image URLs. Single document. */
const contentSchema = new Schema(
  {
    key: { type: String, default: "main", unique: true },
    texts: { type: Map, of: new Schema(bilingual, { _id: false }), default: {} },
    faq: { type: [faqSchema], default: [] },
    pages: {
      privacy: bilingual,
      terms: bilingual,
      referralTerms: bilingual,
    },
    images: {
      hero: { type: String, default: "" },
      cover: { type: String, default: "" },
      retirement: { type: String, default: "" },
      og: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

export const SiteContent = model("SiteContent", contentSchema, "site_content");
export const IMAGE_SLOTS = ["hero", "cover", "retirement", "og"] as const;
export const TEXT_KEYS = ["heroHeadline", "heroSub", "heroText", "priceNote", "referralText", "footerTagline", "disclaimer"] as const;
