import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ok } from "../../common/http";
import { langEnum, validate } from "../../common/validate";
import { BadRequest, NotFound } from "../../common/errors";
import { magicLinkLimiter, signupLimiter, trackingLimiter } from "../../common/rateLimit";
import { clientIp, ipCountry, userAgent, visitorHash } from "../../common/request";
import { verifyBotToken } from "../../common/turnstile";
import { env } from "../../config/env";
import { settingsService } from "../settings/settings.service";
import { contentService } from "../content/content.service";
import { Announcement } from "../announcements/announcement.model";
import { Member } from "../members/member.model";
import { memberService } from "../members/member.service";
import { signupSchema } from "../members/member.schema";
import { Referrer } from "../referrers/referrer.model";
import { referralLink, referrerService } from "../referrers/referrer.service";
import { trackingService } from "../tracking/tracking.service";
import { emailService } from "../emails/email.service";
import { createSession } from "../auth/auth.service";
import { Session } from "../auth/session.model";
import { REFERRER_COOKIE, requireReferrer } from "../auth/auth.middleware";
import { sha256 } from "../../common/utils/crypto";

export const publicRouter = Router();
const REF_COOKIE = "gsta_ref";

async function setRefCookie(res: Response, code: string) {
  const s = await settingsService.get();
  res.cookie(REF_COOKIE, code, { maxAge: s.cookieDays * 86_400_000, sameSite: env.COOKIE_SECURE ? "none" : "lax", secure: env.COOKIE_SECURE, path: "/" });
}

/** Landing page data: settings subset, content, active announcements (statically cacheable for a short time). */
publicRouter.get("/site", async (_req, res) => {
  const [s, c, total] = await Promise.all([settingsService.get(), contentService.get(), Member.estimatedDocumentCount()]);
  const now = new Date();
  const announcements = await Announcement.find({
    status: { $ne: "draft" },
    $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }],
  }).sort({ pinned: -1, sortOrder: 1, createdAt: -1 }).lean();
  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  ok(res, {
    settings: {
      siteMode: s.siteMode, regularPrice: s.regularPrice, vipPrice: s.vipPrice, discountPercent: s.discountPercent,
      commissionPercent: s.commissionPercent, minPayout: s.minPayout, holdingDays: s.holdingDays, cookieDays: s.cookieDays,
      generalVipCode: s.siteMode === "launch" ? s.generalVipCode : null,
      bookLinkEn: s.siteMode === "launch" ? s.bookLinkEn || s.bookLinkEs : null,
      bookLinkEs: s.siteMode === "launch" ? s.bookLinkEs || s.bookLinkEn : null,
      launchDate: s.launchDate, contactEmail: s.contactEmail, social: s.social, gaId: s.gaId,
    },
    content: c,
    announcements,
    memberCount: total,
  });
});

/** Page open: counts the daily visitor; with ?ref= records a referral visit + sets the 60-day cookie (last click wins). */
const visitSchema = z.object({ lang: langEnum.default("en"), ref: z.string().max(30).optional().nullable(), utmSource: z.string().max(100).optional() });
publicRouter.post("/visits", trackingLimiter, validate(visitSchema), async (req, res) => {
  const hash = visitorHash(req);
  await trackingService.pageVisit(hash, req.body.lang, req.body.utmSource);
  let ref = null;
  if (req.body.ref) {
    const r = await referrerService.findActiveByCode(req.body.ref);
    if (r) { await trackingService.referralVisit(r._id, hash, req.body.lang); await setRefCookie(res, r.code); ref = r; }
  }
  if (!ref) ref = await referrerService.findActiveByCode(req.cookies?.[REF_COOKIE]);
  const owner = ref?.memberId ? await Member.findById(ref.memberId, { firstName: 1 }).lean() : null;
  ok(res, { referrer: ref ? { code: ref.code, firstName: owner?.firstName ?? null } : null });
});

/** Welcome bar lookup ("You were invited by …"). Invalid / blocked codes → 404 (ignored by the UI). */
publicRouter.get("/referrers/:code", async (req, res) => {
  const r = await referrerService.findActiveByCode(String(req.params.code));
  if (!r) throw NotFound("Referrer");
  const owner = r.memberId ? await Member.findById(r.memberId, { firstName: 1 }).lean() : null;
  ok(res, { code: r.code, firstName: owner?.firstName ?? null });
});

/** SRS 6.1 signup: bot check + 5/hour/IP rate limit + server validation + duplicate logic. */
publicRouter.post("/signup", signupLimiter, validate(signupSchema), async (req: Request, res) => {
  if (!(await verifyBotToken(req.body.botToken, clientIp(req)))) throw BadRequest("Please try again.", { botToken: ["Please try again."] });
  const r = await memberService.signup(req.body, { ipCountry: ipCountry(req), userAgent: userAgent(req), visitorHash: visitorHash(req), cookieRef: req.cookies?.[REF_COOKIE] });
  ok(res, r, undefined, r.kind === "already" ? 200 : 201);
});

/** Launch mode Buy button: returns the Etsy link for the language + the code to show, and counts the click. */
const buySchema = z.object({ lang: langEnum.default("en"), ref: z.string().max(30).optional().nullable() });
publicRouter.post("/buy-click", trackingLimiter, validate(buySchema), async (req, res) => {
  const s = await settingsService.get();
  const r = await referrerService.findActiveByCode(req.body.ref || req.cookies?.[REF_COOKIE]);
  const code = r?.code ?? s.generalVipCode;
  await trackingService.buyClick(r?._id ?? null, req.body.lang, code);
  const url = (req.body.lang === "es" ? s.bookLinkEs || s.bookLinkEn : s.bookLinkEn || s.bookLinkEs) || null;
  ok(res, { url, code, siteMode: s.siteMode });
});

/** /unsubscribe?token=… one click + Resubscribe (SRS 4.7, CAN-SPAM). */
const tokenSchema = z.object({ token: z.string().min(10).max(200) });
publicRouter.post("/unsubscribe", validate(tokenSchema), async (req, res) => {
  const m = await Member.findOneAndUpdate({ unsubscribeToken: req.body.token }, { status: "unsubscribed", unsubscribedAt: new Date() }, { returnDocument: "after" }).lean();
  if (!m) throw NotFound("Subscription");
  ok(res, { status: m.status, language: m.language });
});
publicRouter.post("/resubscribe", validate(tokenSchema), async (req, res) => {
  const m = await Member.findOneAndUpdate({ unsubscribeToken: req.body.token }, { status: "subscribed", unsubscribedAt: null, consentAt: new Date() }, { returnDocument: "after" }).lean();
  if (!m) throw NotFound("Subscription");
  ok(res, { status: m.status, language: m.language });
});

/* ---------------- /my-referrals (SRS 6.7) ---------------- */
const magicSchema = z.object({ email: z.string().trim().toLowerCase().email(), lang: langEnum.default("en") });
publicRouter.post("/my-referrals/request", magicLinkLimiter, validate(magicSchema), async (req, res) => {
  const m = await Member.findOne({ email: req.body.email }).lean();
  const r = m ? await Referrer.findOne({ memberId: m._id }).lean() : null;
  if (m && r) {
    const token = await createSession("magic", r._id, 30 * 60_000);
    const lang = (m.language as "en" | "es") ?? req.body.lang;
    await emailService.enqueue("E5", { email: m.email, name: m.firstName, lang, memberId: null }, { first_name: m.firstName, magic_link: `${env.SITE_URL}/${lang}/my-referrals?token=${token}` });
  }
  ok(res, { message: "If this email belongs to a referrer, a magic link has been sent." }); // no enumeration
});

publicRouter.post("/my-referrals/verify", magicLinkLimiter, validate(tokenSchema), async (req, res) => {
  const s = await Session.findOneAndDelete({ tokenHash: sha256(req.body.token), kind: "magic", expiresAt: { $gt: new Date() } }).lean(); // single use
  if (!s) throw BadRequest("This link is invalid or has expired. Please request a new one.");
  const token = await createSession("referrer", s.subjectId, 24 * 3_600_000, userAgent(req));
  res.cookie(REFERRER_COOKIE, token, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SECURE ? "none" : "lax", maxAge: 24 * 3_600_000, path: "/" });
  ok(res, { token, expiresInHours: 24 });
});

publicRouter.get("/my-referrals", requireReferrer, async (req, res) => {
  const [row] = await referrerService.withStats({ _id: req.referrerId });
  if (!row) throw NotFound("Referrer");
  const { stats, ...r } = row;
  ok(res, { firstName: row.name.split(" ")[0], code: r.code, link: referralLink(r.code), status: r.status, payoutEmail: r.payoutEmail, payoutMethod: r.payoutMethod, stats: { visits: stats.visits, signups: stats.signups, clicks: stats.clicks, sales: stats.sales, earned: stats.earned, paid: stats.paid, unpaid: stats.unpaid } });
});

const payoutSchema = z.object({ payoutEmail: z.string().trim().toLowerCase().email() });
publicRouter.patch("/my-referrals/payout", requireReferrer, validate(payoutSchema), async (req, res) => {
  await Referrer.updateOne({ _id: req.referrerId }, { payoutEmail: req.body.payoutEmail, payoutMethod: "PayPal" });
  ok(res, { payoutEmail: req.body.payoutEmail });
});

publicRouter.post("/my-referrals/logout", requireReferrer, async (req, res) => {
  const t = req.headers.authorization?.slice(7) || req.cookies?.[REFERRER_COOKIE];
  if (t) await Session.deleteOne({ tokenHash: sha256(t) });
  res.clearCookie(REFERRER_COOKIE, { path: "/" });
  ok(res, { message: "Signed out" });
});
