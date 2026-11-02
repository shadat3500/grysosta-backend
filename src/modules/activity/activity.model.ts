import { Schema, Types, model } from "mongoose";

const activitySchema = new Schema(
  {
    adminId: { type: Types.ObjectId, ref: "Admin", default: null },
    adminName: { type: String, default: "system" },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, default: null },
    details: { type: String, default: "" },
    ip: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
activitySchema.index({ createdAt: -1 });

export const Activity = model("Activity", activitySchema, "activity_log");
