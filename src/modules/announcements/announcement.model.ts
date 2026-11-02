import { Schema, model, type InferSchemaType } from "mongoose";

const announcementSchema = new Schema(
  {
    titleEn: { type: String, required: true },
    titleEs: { type: String, default: "" },
    bodyEn: { type: String, default: "" },
    bodyEs: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    buttonTextEn: { type: String, default: "" },
    buttonTextEs: { type: String, default: "" },
    buttonUrl: { type: String, default: "" },
    pinned: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ["draft", "published", "scheduled"], default: "draft" },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
  },
  { timestamps: true },
);
announcementSchema.index({ status: 1, pinned: -1, sortOrder: 1 });

export type AnnouncementDoc = InferSchemaType<typeof announcementSchema>;
export const Announcement = model("Announcement", announcementSchema, "announcements");

/** Draft / Published / Scheduled / Expired as shown in the admin list (SRS A4). */
export function effectiveStatus(a: { status: string; startsAt?: Date | null; endsAt?: Date | null }, now = new Date()) {
  if (a.status === "draft") return "draft";
  if (a.endsAt && a.endsAt < now) return "expired";
  if (a.startsAt && a.startsAt > now) return "scheduled";
  return "published";
}
