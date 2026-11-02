import { Router } from "express";
import { z } from "zod";
import { ok, pageMeta } from "../../common/http";
import { langEnum, pagination, validate } from "../../common/validate";
import { NotFound } from "../../common/errors";
import { audit } from "../activity/activity.service";
import { EmailLog, EmailTemplate, TEMPLATE_KEYS, type TemplateKey } from "./email.models";
import { emailService, type Audience } from "./email.service";
import { settingsService } from "../settings/settings.service";
import { Member } from "../members/member.model";
import { sendExport } from "../../common/utils/export";

const keyParam = z.object({ key: z.enum(TEMPLATE_KEYS) });
const templateSchema = z.object({ subjectEn: z.string().min(1).max(300), subjectEs: z.string().max(300), bodyEn: z.string().min(1).max(20000), bodyEs: z.string().max(20000) }).partial();
const testSchema = z.object({ lang: langEnum.default("en"), to: z.string().email().optional(), subject: z.string().max(300).optional(), body: z.string().max(20000).optional() });
const audienceSchema = z.object({ audience: z.enum(["all", "en", "es", "referrers"]).default("all") });

export const PLACEHOLDERS = ["{first_name}", "{code}", "{referral_link}", "{book_link}", "{price}", "{vip_price}", "{commission_percent}", "{unsubscribe_link}"];

export const emailRouter = Router();

/** A10 — templates E1–E6 (subject + body, EN / ES) */
emailRouter.get("/templates", async (_req, res) => {
  await emailService.ensureTemplates();
  ok(res, await EmailTemplate.find().sort({ key: 1 }).lean(), { placeholders: PLACEHOLDERS });
});

emailRouter.get("/templates/:key", validate(keyParam, "params"), async (req, res) => {
  const t = await EmailTemplate.findOne({ key: req.params.key as TemplateKey }).lean();
  if (!t) throw NotFound("Template");
  ok(res, t, { placeholders: PLACEHOLDERS });
});

emailRouter.put("/templates/:key", validate(keyParam, "params"), validate(templateSchema), async (req, res) => {
  const t = await EmailTemplate.findOneAndUpdate({ key: req.params.key as TemplateKey }, { $set: req.body }, { returnDocument: "after" });
  if (!t) throw NotFound("Template");
  await audit(req, "Edited email template", "email_templates", String(req.params.key));
  ok(res, t);
});

emailRouter.get("/templates/:key/preview", validate(keyParam, "params"), async (req, res) => {
  const lang = req.query.lang === "es" ? "es" : "en";
  ok(res, await emailService.preview(String(req.params.key), lang));
});

/** "Send test email" → the admin (or `to`). Unsaved subject/body can be passed to test a draft. */
emailRouter.post("/templates/:key/test", validate(keyParam, "params"), validate(testSchema), async (req, res) => {
  const s = await settingsService.get();
  const to = req.body.to ?? req.admin?.email ?? s.contactEmail;
  const mail = await emailService.sendTest(String(req.params.key), req.body.lang, to, { subject: req.body.subject, body: req.body.body });
  await audit(req, "Sent test email", "email_templates", String(req.params.key), to);
  ok(res, { to, subject: mail.subject });
});

/** E4 launch email → audience, batches + progress via GET /emails/logs/:id */
emailRouter.post("/launch", validate(audienceSchema), async (req, res) => {
  const log = await emailService.bulkSend("E4", req.body.audience as Audience, {}, req.admin?.name ?? "admin");
  await audit(req, "Sent launch email", "email_logs", String(log._id), `${log.total} recipients`);
  ok(res, log, undefined, 202);
});

emailRouter.get("/audiences", async (_req, res) => {
  const [all, en, es, referrers] = await Promise.all([
    Member.countDocuments({ status: "subscribed" }),
    Member.countDocuments({ status: "subscribed", language: "en" }),
    Member.countDocuments({ status: "subscribed", language: "es" }),
    Member.countDocuments({ status: "subscribed", isReferrer: true }),
  ]);
  ok(res, { all, en, es, referrers });
});

emailRouter.get("/logs", validate(pagination, "query"), async (req, res) => {
  const q = req.query as unknown as { page: number; limit: number };
  const [items, total] = await Promise.all([EmailLog.find().sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), EmailLog.countDocuments()]);
  ok(res, items, pageMeta(total, q));
});

emailRouter.get("/logs/:id", async (req, res) => {
  const l = await EmailLog.findById(req.params.id).lean();
  if (!l) throw NotFound("Email log");
  ok(res, { ...l, progress: l.total ? Math.round(((l.sent + l.failed + l.skipped) / l.total) * 100) : 100 });
});

emailRouter.get("/unsubscribed", validate(pagination.extend({ format: z.enum(["json", "csv", "xlsx"]).default("json") }), "query"), async (req, res) => {
  const q = req.query as unknown as { page: number; limit: number; format: string };
  if (q.format !== "json") {
    const rows = await Member.find({ status: "unsubscribed" }).lean();
    return sendExport(res, rows.map((m) => ({ name: `${m.firstName} ${m.lastName}`, email: m.email, language: m.language, unsubscribed_at: m.unsubscribedAt ?? "" })), "unsubscribed", q.format as "csv");
  }
  const [items, total] = await Promise.all([
    Member.find({ status: "unsubscribed" }, { firstName: 1, lastName: 1, email: 1, language: 1, unsubscribedAt: 1, createdAt: 1 }).sort({ unsubscribedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Member.countDocuments({ status: "unsubscribed" }),
  ]);
  ok(res, items, pageMeta(total, q));
});
