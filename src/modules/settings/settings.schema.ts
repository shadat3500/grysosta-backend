import { z } from "zod";

const url = z.union([z.string().url(), z.literal("")]);

export const updateSettingsSchema = z
  .object({
    commissionPercent: z.number().min(0).max(50),
    discountPercent: z.number().min(0).max(90),
    commissionBase: z.enum(["after_discount", "net"]),
    etsyFeePercent: z.number().min(0).max(50),
    minPayout: z.number().min(0),
    holdingDays: z.number().int().min(0).max(365),
    cookieDays: z.number().int().min(1).max(365),
    contactEmail: z.string().email(),
    mailingAddress: z.string().max(500),
    social: z.object({ facebook: url, instagram: url, x: url, youtube: url, tiktok: url }).partial(),
    gaId: z.string().max(40),
    dailySummary: z.boolean(),
  })
  .partial()
  .strict();

/** A3 Site mode & book links. */
export const siteModeSchema = z
  .object({
    siteMode: z.enum(["prelaunch", "launch"]),
    bookLinkEn: url,
    bookLinkEs: url,
    regularPrice: z.number().positive(),
    vipPrice: z.number().positive(),
    generalVipCode: z.string().min(4).max(20),
    launchDate: z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), z.null()]),
    autoVipPrice: z.boolean(),
  })
  .partial()
  .strict();
