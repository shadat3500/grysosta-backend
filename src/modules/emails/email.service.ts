import { Types } from "mongoose";
import { EmailJob, EmailLog, EmailTemplate, type TemplateKey } from "./email.models";
import { DEFAULT_TEMPLATES } from "./email.defaults";
import { renderEmail, type Vars } from "./email.render";
import { mailProvider } from "./email.provider";
import { Member, type MemberDoc } from "../members/member.model";
import { Referrer } from "../referrers/referrer.model";
import { referralLink } from "../referrers/referrer.service";
import { settingsService } from "../settings/settings.service";
import { contentService } from "../content/content.service";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { usd } from "../../common/utils/money";
import { dayKey, startOfDay } from "../../common/utils/dates";
import { BadRequest, NotFound } from "../../common/errors";

type Lang = "en" | "es";
export type Audience = "all" | "en" | "es" | "referrers";
export const AUDIENCE_LABEL: Record<Audience, string> = { all: "All members", en: "English only", es: "Spanish only", referrers: "Referrers only" };

/** E1–E4 are never sent to unsubscribed members (SRS 7.2). */
const MARKETING: string[] = ["E1", "E2", "E3", "E4"];
const MAX_ATTEMPTS = 3;

interface Tpl { key: string; name: string; subjectEn: string; subjectEs: string; bodyEn: string; bodyEs: string }
async function getTemplate(key: string): Promise<Tpl> {
  const t = (await EmailTemplate.findOne({ key: key as TemplateKey }).lean()) as Tpl | null;
  if (t) return t;
  const d = DEFAULT_TEMPLATES.find((x) => x.key === key);
  if (!d) throw NotFound("Template");
  return d;
}

export function audienceFilter(a: Audience) {
  const f: Record<string, unknown> = { status: "subscribed" };
  if (a === "en" || a === "es") f.language = a;
  if (a === "referrers") f.isReferrer = true;
  return f;
}

/** {code} in E4 = own referral code → else the referrer's code → else the general VIP code (SRS 7.5). */
async function memberVars(m: Pick<MemberDoc, "_id" | "firstName" | "language" | "unsubscribeToken" | "referredBy" | "isReferrer">): Promise<Vars> {
  const s = await settingsService.get();
  const lang = m.language as Lang;
  let code = s.generalVipCode;
  let own: string | null = null;
  if (m.isReferrer) {
    const r = await Referrer.findOne({ memberId: m._id }, { code: 1, status: 1 }).lean();
    if (r && r.status !== "blocked") own = code = r.code;
  }
  if (!own && m.referredBy) {
    const r = await Referrer.findOne({ _id: m.referredBy, status: "active" }, { code: 1 }).lean();
    if (r) code = r.code;
  }
  const book = (lang === "es" ? s.bookLinkEs || s.bookLinkEn : s.bookLinkEn || s.bookLinkEs) || env.SITE_URL;
  const link = own ? referralLink(own) : `${env.SITE_URL}/${lang}`;
  return {
    first_name: m.firstName,
    code,
    referral_link: link,
    book_link: book,
    price: usd(s.regularPrice),
    vip_price: usd(s.vipPrice),
    commission_percent: s.commissionPercent,
    unsubscribe_link: `${env.SITE_URL}/${lang}/unsubscribe?token=${m.unsubscribeToken}`,
    my_referrals_link: `${env.SITE_URL}/${lang}/my-referrals`,
    share_text: lang === "es" ? `Únase con mi enlace y ahorre 10%. #ad — Gano una comisión si compra con mi código ${code}.` : `Join with my link and save 10%! #ad — I earn a commission if you buy with my code ${code}.`,
  };
}

const DEFAULT_BUTTON: Record<string, (v: Vars, lang: Lang) => string> = {
  E1: (_v, l) => `${env.SITE_URL}/${l}#join`,
  E2: (v) => String(v.referral_link),
  E3: (_v, l) => `${env.SITE_URL}/${l}`,
  E4: (v) => String(v.book_link),
  E5: (v) => String(v.magic_link ?? env.SITE_URL),
  E6: () => `${env.SITE_URL}/admin`,
};

async function render(key: string, lang: Lang, vars: Vars) {
  const [t, s, c] = await Promise.all([getTemplate(key), settingsService.get(), contentService.get()]);
  const subject = lang === "es" && t.subjectEs?.trim() ? t.subjectEs : t.subjectEn;
  const body = lang === "es" && t.bodyEs?.trim() ? t.bodyEs : t.bodyEn;
  const v: Vars = { button_url: DEFAULT_BUTTON[key]?.(vars, lang) ?? env.SITE_URL, ...vars };
  if (lang === "es") for (const k of Object.keys(v)) if (k.endsWith("_es") && String(v[k]).trim()) v[k.slice(0, -3)] = v[k]; // e.g. announcement_title_es
  return renderEmail({ subject, body }, v, {
    disclaimer: contentService.pick(c.texts.disclaimer, lang) || "Educational purposes only. Stock trading involves financial risk, and profits are not guaranteed.",
    address: s.mailingAddress,
    unsubscribeLabel: lang === "es" ? "Cancelar suscripción" : "Unsubscribe",
    unsubscribeUrl: vars.unsubscribe_link ? String(vars.unsubscribe_link) : undefined,
  });
}

async function transactionalLog(templateKey: string) {
  const t = await getTemplate(templateKey);
  const day = dayKey();
  return EmailLog.findOneAndUpdate(
    { templateKey, audience: "Transactional", type: `${t.name} · ${day}` },
    { $setOnInsert: { status: "sending", startedAt: new Date() }, $inc: { total: 1 } },
    { upsert: true, returnDocument: "after" },
  );
}

export const emailService = {
  render,
  memberVars,

  async ensureTemplates() {
    for (const t of DEFAULT_TEMPLATES) await EmailTemplate.updateOne({ key: t.key }, { $setOnInsert: t }, { upsert: true });
  },

  /** Queue a transactional email (E1, E2, E5, E6 …) — sent by the worker within seconds. */
  async enqueue(key: TemplateKey, to: { email: string; name?: string; lang: Lang; memberId?: Types.ObjectId | null }, vars: Vars) {
    const log = await transactionalLog(key);
    await EmailJob.create({ to: to.email, name: to.name ?? "", lang: to.lang, templateKey: key, memberId: to.memberId ?? null, vars, logId: log._id, priority: 1 });
  },

  async enqueueForMember(key: TemplateKey, m: MemberDoc, extra: Vars = {}) {
    if (MARKETING.includes(key) && m.status !== "subscribed") return;
    const vars = { ...(await memberVars(m)), ...extra };
    await this.enqueue(key, { email: m.email, name: m.firstName, lang: m.language as Lang, memberId: m._id }, vars);
  },

  /** Bulk E3 / E4 — creates a log and fans out jobs in chunks (never blocks the request). */
  async bulkSend(key: "E3" | "E4", audience: Audience, extra: Vars, createdBy: string) {
    const t = await getTemplate(key);
    const filter = audienceFilter(audience);
    const total = await Member.countDocuments(filter);
    if (!total) throw BadRequest("No subscribed members in this audience");
    const log = await EmailLog.create({ templateKey: key, type: t.name, audience: AUDIENCE_LABEL[audience], total, status: "queued", createdBy });
    (async () => {
      const cursor = Member.find(filter, { email: 1, firstName: 1, language: 1 }).lean().cursor({ batchSize: 1000 });
      let chunk: Record<string, unknown>[] = [];
      for await (const m of cursor) {
        chunk.push({ to: m.email, name: m.firstName, lang: m.language, templateKey: key, memberId: m._id, vars: extra, logId: log._id, bulk: true, priority: 5 });
        if (chunk.length >= 1000) { await EmailJob.insertMany(chunk, { ordered: false }); chunk = []; }
      }
      if (chunk.length) await EmailJob.insertMany(chunk, { ordered: false });
      const l = await EmailLog.findByIdAndUpdate(log._id, { status: "sending" }, { returnDocument: "after" });
      if (l && l.sent + l.failed + l.skipped >= l.total) await EmailLog.updateOne({ _id: log._id }, { status: "done", finishedAt: new Date() });
    })().catch((e) => logger.error(e, "bulk fan-out failed"));
    return log;
  },

  /** "Send test email" — rendered with sample data and sent immediately to the admin. */
  async sendTest(key: string, lang: Lang, to: string, override?: { subject?: string; body?: string }) {
    const sample: Vars = {
      first_name: "John", code: "GSTAJOHN27", referral_link: referralLink("GSTAJOHN27"), unsubscribe_link: `${env.SITE_URL}/${lang}/unsubscribe?token=test`,
      announcement_title: "Sample announcement", announcement_body: "This is how an announcement looks.", magic_link: `${env.SITE_URL}/${lang}/my-referrals`,
      new_signups: 12, new_referrers: 3, total_members: 1200, visitors: 340, top_referrers: "GSTAJOHN27 — 4 signups",
    };
    const base = { ...(await memberVars({ _id: new Types.ObjectId(), firstName: "John", language: lang, unsubscribeToken: "test", referredBy: null, isReferrer: false })), ...sample };
    let mail;
    if (override?.subject || override?.body) {
      const s = await settingsService.get();
      const c = await contentService.get();
      mail = renderEmail({ subject: override.subject ?? "", body: override.body ?? "" }, { button_url: DEFAULT_BUTTON[key]?.(base, lang) ?? env.SITE_URL, ...base }, { disclaimer: contentService.pick(c.texts.disclaimer, lang), address: s.mailingAddress, unsubscribeLabel: "Unsubscribe", unsubscribeUrl: String(base.unsubscribe_link) });
    } else mail = await render(key, lang, base);
    const s = await settingsService.get();
    await mailProvider.send({ to, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text, replyTo: s.contactEmail });
    return mail;
  },

  async preview(key: string, lang: Lang) {
    const base = await memberVars({ _id: new Types.ObjectId(), firstName: "John", language: lang, unsubscribeToken: "preview", referredBy: null, isReferrer: false });
    return render(key, lang, { ...base, code: "GSTAJOHN27", referral_link: referralLink("GSTAJOHN27"), announcement_title: "Sample announcement", announcement_body: "Announcement text", magic_link: `${env.SITE_URL}/${lang}/my-referrals` });
  },

  /** Worker tick (returns jobs processed): respects the Brevo daily limit, retries failures, safe across instances. */
  async processBatch(): Promise<number> {
    await EmailJob.updateMany({ status: "processing", lockedAt: { $lt: new Date(Date.now() - 10 * 60_000) } }, { status: "pending" });
    const sentToday = await EmailJob.countDocuments({ status: "sent", sentAt: { $gte: startOfDay() } });
    const room = Math.min(env.EMAIL_BATCH_SIZE, env.EMAIL_DAILY_LIMIT - sentToday);
    let done = 0;
    for (let i = 0; i < room; i++) {
      const job = await EmailJob.findOneAndUpdate(
        { status: "pending", runAt: { $lte: new Date() } },
        { status: "processing", lockedAt: new Date(), $inc: { attempts: 1 } },
        { sort: { priority: 1, runAt: 1 }, returnDocument: "after" },
      );
      if (!job) break;
      done++;
      try {
        let vars = (job.vars ?? {}) as Vars;
        if (job.memberId) {
          const m = await Member.findById(job.memberId).lean();
          if (!m || (MARKETING.includes(job.templateKey) && m.status !== "subscribed")) {
            await EmailJob.updateOne({ _id: job._id }, { status: "skipped" });
            await this.bumpLog(job.logId, "skipped");
            continue;
          }
          vars = { ...(await memberVars(m as MemberDoc)), ...vars };
        }
        const mail = await render(job.templateKey, job.lang as Lang, vars);
        const s = await settingsService.get();
        await mailProvider.send({
          to: job.to, name: job.name, subject: mail.subject, html: mail.html, text: mail.text, replyTo: s.contactEmail,
          headers: vars.unsubscribe_link ? { "List-Unsubscribe": `<${vars.unsubscribe_link}>` } : undefined,
        });
        await EmailJob.updateOne({ _id: job._id }, { status: "sent", sentAt: new Date(), error: "" });
        await this.bumpLog(job.logId, "sent");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ err: msg, to: job.to }, "email send failed");
        if (job.attempts >= MAX_ATTEMPTS) {
          await EmailJob.updateOne({ _id: job._id }, { status: "failed", error: msg });
          await this.bumpLog(job.logId, "failed");
        } else {
          await EmailJob.updateOne({ _id: job._id }, { status: "pending", error: msg, runAt: new Date(Date.now() + job.attempts * 60_000) });
        }
      }
    }
    return done;
  },

  async bumpLog(logId: Types.ObjectId | null | undefined, field: "sent" | "failed" | "skipped") {
    if (!logId) return;
    const log = await EmailLog.findByIdAndUpdate(logId, { $inc: { [field]: 1 } }, { returnDocument: "after" });
    if (log && log.audience !== "Transactional" && log.status === "sending" && log.sent + log.failed + log.skipped >= log.total) {
      await EmailLog.updateOne({ _id: logId }, { status: "done", finishedAt: new Date() });
    }
    if (log && log.audience === "Transactional") await EmailLog.updateOne({ _id: logId }, { finishedAt: new Date() });
  },

  /** Drain the queue right away (used by tests and after admin actions in dev). */
  async drain(max = 1000) {
    let total = 0;
    for (let i = 0; i < max; i++) { const n = await this.processBatch(); total += n; if (!n) break; }
    return total;
  },
};
