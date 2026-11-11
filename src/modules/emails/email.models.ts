import { Schema, Types, model } from "mongoose";

export const TEMPLATE_KEYS = ["E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

const templateSchema = new Schema(
  {
    key: { type: String, enum: TEMPLATE_KEYS, required: true, unique: true },
    name: { type: String, required: true },
    subjectEn: { type: String, required: true },
    subjectEs: { type: String, default: "" },
    bodyEn: { type: String, required: true },
    bodyEs: { type: String, default: "" },
  },
  { timestamps: true },
);
export const EmailTemplate = model("EmailTemplate", templateSchema, "email_templates");

/** Bulk send progress (SRS 7.2 / A10 email log). */
const logSchema = new Schema(
  {
    templateKey: { type: String, required: true },
    type: { type: String, required: true },
    audience: { type: String, default: "Transactional" },
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    status: { type: String, enum: ["queued", "sending", "done"], default: "queued" },
    startedAt: { type: Date, default: () => new Date() },
    finishedAt: { type: Date, default: null },
    createdBy: { type: String, default: "system" },
  },
  { timestamps: true },
);
logSchema.index({ createdAt: -1 });
export const EmailLog = model("EmailLog", logSchema, "email_logs");

/** Outbox — processed in batches by the worker; safe for several API instances (atomic claim). */
const jobSchema = new Schema(
  {
    to: { type: String, required: true },
    name: { type: String, default: "" },
    lang: { type: String, enum: ["en", "es"], default: "en" },
    templateKey: { type: String, required: true },
    memberId: { type: Types.ObjectId, default: null },
    vars: { type: Schema.Types.Mixed, default: {} },
    logId: { type: Types.ObjectId, default: null, index: true },
    bulk: { type: Boolean, default: false },
    priority: { type: Number, default: 5 },
    status: { type: String, enum: ["pending", "processing", "sent", "failed", "skipped"], default: "pending" },
    attempts: { type: Number, default: 0 },
    runAt: { type: Date, default: () => new Date() },
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    error: { type: String, default: "" },
  },
  { timestamps: true },
);
jobSchema.index({ status: 1, priority: 1, runAt: 1 });
jobSchema.index({ status: 1, sentAt: 1 });
export const EmailJob = model("EmailJob", jobSchema, "email_jobs");
