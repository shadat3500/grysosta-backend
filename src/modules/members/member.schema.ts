import { z } from "zod";
import { dateRange, langEnum, objectId, pagination } from "../../common/validate";

const NAME = /^[\p{L}][\p{L} '\-]{1,49}$/u;

/** SRS 6.1 — validated on the server too. */
export const signupSchema = z.object({
  firstName: z.string().trim().regex(NAME, "Please enter your first name."),
  lastName: z.string().trim().min(2, "Please enter your last name.").max(50, "Please enter your last name."),
  email: z.string().trim().toLowerCase().email("Please enter a valid email address."),
  language: langEnum,
  joinReferral: z.boolean().default(false),
  consent: z.literal(true, { message: "Please agree to receive emails." }),
  refCode: z.string().max(30).optional().nullable(),
  utmSource: z.string().max(100).optional(),
  utmMedium: z.string().max(100).optional(),
  utmCampaign: z.string().max(100).optional(),
  botToken: z.string().max(4000).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const listMembersSchema = pagination.merge(dateRange).extend({
  q: z.string().max(100).optional(),
  language: langEnum.optional(),
  status: z.enum(["subscribed", "unsubscribed"]).optional(),
  referredBy: z.union([objectId, z.enum(["any", "none"])]).optional(),
  isReferrer: z.enum(["true", "false"]).optional(),
  format: z.enum(["json", "csv", "xlsx"]).default("json"),
});

export const updateMemberSchema = z.object({
  firstName: z.string().trim().min(2).max(50),
  lastName: z.string().trim().min(2).max(50),
  language: langEnum,
}).partial().strict();

export const bulkSchema = z.object({ action: z.enum(["unsubscribe", "delete", "export"]), ids: z.array(objectId).min(1).max(5000), format: z.enum(["csv", "xlsx"]).default("csv") });
