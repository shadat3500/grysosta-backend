import { Types } from "mongoose";
import { Referrer, RetiredCode, type ReferrerDoc } from "./referrer.model";
import { Member } from "../members/member.model";
import { Sale } from "../sales/sales.models";
import { Payout } from "../payouts/payout.model";
import { BuyClick } from "../tracking/tracking.models";
import { codeCandidate, hasBlockedWord, normalizeCode } from "../../common/utils/codes";
import { round2 } from "../../common/utils/money";
import { BadRequest, Conflict } from "../../common/errors";
import { settingsService } from "../settings/settings.service";
import { env } from "../../config/env";

export interface ReferrerStats {
  visits: number; signups: number; clicks: number; sales: number; salesTotal: number;
  earned: number; pending: number; approved: number; paid: number; clawback: number; unpaid: number; ready: number;
}

export const referralLink = (code: string) => `${env.SITE_URL}/?ref=${code}`;

async function codeTaken(code: string) {
  const s = await settingsService.get();
  return code === s.generalVipCode || !!(await Referrer.exists({ code })) || !!(await RetiredCode.exists({ code }));
}

export const referrerService = {
  /** SRS 6.3 unique code generator (retries on collision, never reuses retired codes). */
  async generateCode(firstName: string) {
    for (let i = 0; i < 200; i++) {
      const c = codeCandidate(firstName, i);
      if (!hasBlockedWord(c) && !(await codeTaken(c))) return c;
    }
    throw Conflict("Could not generate a unique code");
  },

  async createForMember(memberId: Types.ObjectId, firstName: string) {
    for (let i = 0; i < 5; i++) {
      const code = await this.generateCode(firstName);
      try {
        const r = await Referrer.create({ memberId, code });
        await Member.updateOne({ _id: memberId }, { isReferrer: true });
        return r;
      } catch (e: unknown) {
        if ((e as { code?: number }).code === 11000 && i < 4) continue; // race on unique index → retry
        throw e;
      }
    }
    throw Conflict("Could not create referrer");
  },

  /** Valid only if the referrer is active (paused/blocked links are ignored silently — SRS 6.4). */
  async findActiveByCode(raw?: string | null) {
    if (!raw) return null;
    const c = normalizeCode(raw);
    if (!c) return null;
    const r = await Referrer.findOne({ code: { $in: [c, `GSTA${c}`] }, status: "active" }).lean();
    return r as ReferrerDoc | null;
  },

  /** Public attribution (?ref=, cookie, signup, purchase). Ignored entirely while the referral program is locked. */
  async findActivePublic(raw?: string | null) {
    const s = await settingsService.get();
    if (!s.referralEnabled) return null;
    return this.findActiveByCode(raw);
  },

  async changeCode(id: string, raw: string) {
    const code = normalizeCode(raw);
    if (code.length < 4) throw BadRequest("Code must be at least 4 letters/numbers");
    if (hasBlockedWord(code)) throw BadRequest("This code contains a blocked word");
    const cur = await Referrer.findById(id);
    if (!cur) throw BadRequest("Referrer not found");
    if (cur.code === code) return cur;
    if (await codeTaken(code)) throw Conflict("This code is already used");
    await RetiredCode.updateOne({ code: cur.code }, { code: cur.code }, { upsert: true });
    cur.code = code;
    cur.etsyCreated = false;
    cur.etsyCreatedAt = null;
    await cur.save();
    return cur;
  },

  /** Batch stats via aggregation (one query per metric, not per referrer) — scales to many referrers. */
  async statsFor(ids: Types.ObjectId[]): Promise<Map<string, ReferrerStats>> {
    const match = { $in: ids };
    const [refs, signups, clicks, sales, payouts] = await Promise.all([
      Referrer.find({ _id: match }, { visits: 1 }).lean(),
      Member.aggregate([{ $match: { referredBy: match } }, { $group: { _id: "$referredBy", n: { $sum: 1 } } }]),
      BuyClick.aggregate([{ $match: { referrerId: match } }, { $group: { _id: "$referrerId", n: { $sum: 1 } } }]),
      Sale.aggregate([
        { $match: { referrerId: match } },
        {
          $group: {
            _id: "$referrerId",
            sales: { $sum: { $cond: ["$refunded", 0, 1] } },
            salesTotal: { $sum: { $cond: ["$refunded", 0, "$baseAmount"] } },
            pending: { $sum: { $cond: [{ $eq: ["$commissionStatus", "pending"] }, "$commissionAmount", 0] } },
            approved: { $sum: { $cond: [{ $eq: ["$commissionStatus", "approved"] }, "$commissionAmount", 0] } },
            paidSales: { $sum: { $cond: [{ $eq: ["$commissionStatus", "paid"] }, "$commissionAmount", 0] } },
            clawback: { $sum: { $cond: ["$clawbackOpen", "$commissionAmount", 0] } },
          },
        },
      ]),
      Payout.aggregate([{ $match: { referrerId: match } }, { $group: { _id: "$referrerId", n: { $sum: "$amount" } } }]),
    ]);
    const m = (arr: { _id: Types.ObjectId }[]) => new Map(arr.map((x) => [String(x._id), x as Record<string, number> & { _id: Types.ObjectId }]));
    const sg = m(signups), ck = m(clicks), sl = m(sales), po = m(payouts);
    const out = new Map<string, ReferrerStats>();
    for (const r of refs) {
      const k = String(r._id);
      const s = sl.get(k);
      const pending = round2(s?.pending ?? 0), approved = round2(s?.approved ?? 0), clawback = round2(s?.clawback ?? 0);
      out.set(k, {
        visits: r.visits ?? 0,
        signups: sg.get(k)?.n ?? 0,
        clicks: ck.get(k)?.n ?? 0,
        sales: s?.sales ?? 0,
        salesTotal: round2(s?.salesTotal ?? 0),
        pending, approved, clawback,
        earned: round2(pending + approved + (s?.paidSales ?? 0)),
        paid: round2(po.get(k)?.n ?? 0),
        unpaid: round2(pending + approved - clawback),
        ready: round2(approved - clawback),
      });
    }
    return out;
  },

  async withStats(filter: Record<string, unknown> = {}) {
    const refs = await Referrer.find({ deletedMember: { $ne: true }, ...filter }).populate<{ memberId: { _id: Types.ObjectId; firstName: string; lastName: string; email: string; language: string } | null }>("memberId", "firstName lastName email language").lean();
    const stats = await this.statsFor(refs.map((r) => r._id));
    return refs.map((r) => ({
      id: String(r._id),
      code: r.code,
      link: referralLink(r.code),
      status: r.status,
      etsyCreated: r.etsyCreated,
      etsyCreatedAt: r.etsyCreatedAt,
      payoutMethod: r.payoutMethod,
      payoutEmail: r.payoutEmail,
      notes: r.notes,
      createdAt: (r as unknown as { createdAt: Date }).createdAt,
      memberId: r.memberId?._id ?? null,
      name: r.memberId ? `${r.memberId.firstName} ${r.memberId.lastName}` : "Deleted member",
      email: r.memberId?.email ?? "",
      language: r.memberId?.language ?? "en",
      stats: stats.get(String(r._id))!,
    }));
  },
};
