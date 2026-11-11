import { Types } from "mongoose";
import { Member, TIER_RANK, tierQuery, type MemberDoc, type Tier } from "./member.model";
import { Referrer, RetiredCode } from "../referrers/referrer.model";
import { referralLink, referrerService } from "../referrers/referrer.service";
import { emailService } from "../emails/email.service";
import { settingsService } from "../settings/settings.service";
import type { SignupInput } from "./member.schema";
import { randomToken } from "../../common/utils/crypto";
import { escapeRegex } from "../../common/utils/regex";
import { rangeFilter } from "../../common/validate";

export type SignupResult =
  | { kind: "vip" | "reserve"; member: Pick<MemberDoc, "firstName" | "email" | "language"> }
  | { kind: "referrer" | "upgraded"; member: Pick<MemberDoc, "firstName" | "email" | "language">; code: string; link: string }
  | { kind: "already"; member: Pick<MemberDoc, "firstName" | "email" | "language"> };

const pub = (m: MemberDoc) => ({ firstName: m.firstName, email: m.email, language: m.language });

export const memberService = {
  /**
   * SRS 2.2 + 6.1 + 6.2 signup / duplicate / upgrade logic.
   * Tier: a higher-priority option (Reserve over VIP) upgrades an existing member; nobody is ever moved down.
   * Referral checkbox: ignored while the referral program is locked (settings.referralEnabled = false).
   */
  async signup(i: SignupInput, meta: { ipCountry: string; userAgent: string; visitorHash: string; cookieRef?: string | null }): Promise<SignupResult> {
    const s = await settingsService.get();
    const wantsReferral = s.referralEnabled && i.joinReferral;
    const existing = (await Member.findOne({ email: i.email }).lean()) as MemberDoc | null;
    if (existing) {
      const current = (existing.tier ?? "vip") as Tier;
      if (TIER_RANK[i.tier] < TIER_RANK[current]) await Member.updateOne({ _id: existing._id }, { tier: i.tier });
      if (wantsReferral && !existing.isReferrer) {
        const r = await referrerService.createForMember(existing._id, existing.firstName);
        await emailService.enqueueForMember("E2", { ...existing, isReferrer: true });
        await Member.updateOne({ _id: existing._id }, { lastWelcomeAt: new Date() });
        return { kind: "upgraded", member: pub(existing), code: r.code, link: referralLink(r.code) };
      }
      // resend welcome, max once per 24 hours
      if (!existing.lastWelcomeAt || Date.now() - new Date(existing.lastWelcomeAt).getTime() > 86_400_000) {
        await Member.updateOne({ _id: existing._id }, { lastWelcomeAt: new Date() });
        await emailService.enqueueForMember(existing.isReferrer ? "E2" : "E1", existing);
      }
      return { kind: "already", member: pub(existing) };
    }

    const ref = await referrerService.findActivePublic(i.refCode || meta.cookieRef);
    let referredBy: Types.ObjectId | null = ref?._id ?? null;
    if (ref?.memberId) {
      const owner = await Member.findById(ref.memberId, { email: 1 }).lean();
      if (owner?.email === i.email) referredBy = null; // no self-referral (SRS 6.4)
    }
    const now = new Date();
    let m: MemberDoc;
    try {
      m = (await Member.create({
        firstName: i.firstName, lastName: i.lastName, email: i.email, language: i.language, tier: i.tier,
        referredBy, status: "subscribed", unsubscribeToken: randomToken(24), consentAt: now,
        ipCountry: meta.ipCountry, userAgent: meta.userAgent, visitorHash: meta.visitorHash,
        utmSource: i.utmSource || (referredBy ? "referral" : null), utmMedium: i.utmMedium || (referredBy ? "link" : null), utmCampaign: i.utmCampaign || null,
        lastWelcomeAt: now,
      })).toObject() as MemberDoc;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return this.signup(i, meta); // concurrent duplicate → duplicate path
      throw e;
    }
    if (wantsReferral) {
      const r = await referrerService.createForMember(m._id, m.firstName);
      await emailService.enqueueForMember("E2", { ...m, isReferrer: true });
      return { kind: "referrer", member: pub(m), code: r.code, link: referralLink(r.code) };
    }
    await emailService.enqueueForMember("E1", m);
    return { kind: i.tier, member: pub(m) };
  },

  buildFilter(q: { q?: string; language?: string; status?: string; referredBy?: string; isReferrer?: string; tier?: Tier; from?: string; to?: string }) {
    const f: Record<string, unknown> = {};
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q.trim()), "i");
      f.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }];
    }
    if (q.language) f.language = q.language;
    if (q.status) f.status = q.status;
    if (q.isReferrer) f.isReferrer = q.isReferrer === "true";
    if (q.tier) f.tier = tierQuery(q.tier);
    if (q.referredBy === "any") f.referredBy = { $ne: null };
    else if (q.referredBy === "none") f.referredBy = null;
    else if (q.referredBy) f.referredBy = new Types.ObjectId(q.referredBy);
    const r = rangeFilter(q.from, q.to);
    if (r) f.createdAt = r;
    return f;
  },

  /** GDPR-style delete: personal data removed; their referral code is retired and never reused. */
  async deleteMany(ids: string[]) {
    const oids = ids.map((x) => new Types.ObjectId(x));
    const refs = await Referrer.find({ memberId: { $in: oids } }).lean();
    if (refs.length) {
      await RetiredCode.insertMany(refs.map((r) => ({ code: r.code })), { ordered: false }).catch(() => undefined);
      await Referrer.updateMany({ _id: { $in: refs.map((r) => r._id) } }, { memberId: null, deletedMember: true, status: "blocked", payoutEmail: "", notes: "Member deleted (GDPR)" });
    }
    const r = await Member.deleteMany({ _id: { $in: oids } });
    return r.deletedCount;
  },

  async unsubscribeMany(ids: string[]) {
    const r = await Member.updateMany({ _id: { $in: ids.map((x) => new Types.ObjectId(x)) }, status: "subscribed" }, { status: "unsubscribed", unsubscribedAt: new Date() });
    return r.modifiedCount;
  },

  /** Registrations per group (Prepay / Reserve / VIP) — total, paid (prepay) and invited. */
  async groupCounts() {
    const rows = await Member.aggregate([
      { $group: { _id: { $ifNull: ["$tier", "vip"] }, total: { $sum: 1 }, paid: { $sum: { $cond: [{ $ne: ["$prepaidAt", null] }, 1, 0] } }, invited: { $sum: { $cond: [{ $ne: ["$invitedAt", null] }, 1, 0] } } } },
    ]);
    const out = { prepay: { total: 0, paid: 0, invited: 0 }, reserve: { total: 0, paid: 0, invited: 0 }, vip: { total: 0, paid: 0, invited: 0 } };
    for (const r of rows) if (r._id in out) out[r._id as Tier] = { total: r.total, paid: r.paid, invited: r.invited };
    return out;
  },

  async exportRows(filter: Record<string, unknown>) {
    const members = await Member.find(filter).sort({ createdAt: -1 }).lean();
    const refIds = [...new Set(members.map((m) => String(m.referredBy ?? "")).filter(Boolean))];
    const codes = new Map((await Referrer.find({ _id: { $in: refIds } }, { code: 1 }).lean()).map((r) => [String(r._id), r.code]));
    return members.map((m) => ({
      first_name: m.firstName, last_name: m.lastName, email: m.email, language: m.language, group: (m.tier ?? "vip") as string, is_referrer: m.isReferrer ? "yes" : "no",
      paid: m.prepaidAt ? "yes" : "no", invited: m.invitedAt ? "yes" : "no",
      referred_by: m.referredBy ? codes.get(String(m.referredBy)) ?? "" : "", status: m.status,
      utm_source: m.utmSource ?? "", utm_medium: m.utmMedium ?? "", utm_campaign: m.utmCampaign ?? "", ip_country: m.ipCountry, signup_date: (m as unknown as { createdAt: Date }).createdAt.toISOString(),
    }));
  },
};
