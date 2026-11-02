import { Schema, model, type InferSchemaType } from "mongoose";

const settingsSchema = new Schema(
  {
    key: { type: String, default: "global", unique: true },
    commissionPercent: { type: Number, default: 10, min: 0, max: 50 },
    discountPercent: { type: Number, default: 10, min: 0, max: 90 },
    commissionBase: { type: String, enum: ["after_discount", "net"], default: "after_discount" },
    etsyFeePercent: { type: Number, default: 9.5 },
    minPayout: { type: Number, default: 20 },
    holdingDays: { type: Number, default: 30 },
    cookieDays: { type: Number, default: 60 },
    siteMode: { type: String, enum: ["prelaunch", "launch"], default: "prelaunch" },
    bookLinkEn: { type: String, default: "" },
    bookLinkEs: { type: String, default: "" },
    regularPrice: { type: Number, default: 59.99 },
    vipPrice: { type: Number, default: 53.99 },
    generalVipCode: { type: String, default: "GSTAVIP10" },
    launchDate: { type: Date, default: null },
    contactEmail: { type: String, default: "info@grysosta.com" },
    mailingAddress: { type: String, default: "" },
    social: {
      facebook: { type: String, default: "" },
      instagram: { type: String, default: "" },
      x: { type: String, default: "" },
      youtube: { type: String, default: "" },
      tiktok: { type: String, default: "" },
    },
    gaId: { type: String, default: "" },
    dailySummary: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type SettingsDoc = InferSchemaType<typeof settingsSchema>;
export const Settings = model("Settings", settingsSchema, "settings");
