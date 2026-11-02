import { Types } from "mongoose";
import { PAYOUT_METHODS, Payout, PayoutSale } from "./payout.model";
import { Sale } from "../sales/sales.models";
import { Referrer } from "../referrers/referrer.model";
import { BadRequest, NotFound } from "../../common/errors";
import { round2 } from "../../common/utils/money";

export const payoutService = {
  /** SRS 9.5 — record a payout; Approved commissions (oldest first) up to the amount (+ open refund balance) become Paid. */
  async record(i: { referrerId: string; amount: number; paidOn: string; method: (typeof PAYOUT_METHODS)[number]; transactionId?: string; note?: string }, createdBy: string) {
    const ref = await Referrer.findById(i.referrerId).lean();
    if (!ref) throw NotFound("Referrer");
    if (ref.status === "blocked") throw BadRequest("This referrer is blocked — unpaid commission is frozen");
    const rid = new Types.ObjectId(i.referrerId);
    const clawbacks = await Sale.find({ referrerId: rid, clawbackOpen: true }).lean();
    const clawback = clawbacks.reduce((a, s) => a + s.commissionAmount, 0);
    const approved = await Sale.find({ referrerId: rid, commissionStatus: "approved" }).sort({ saleDate: 1 }).lean();
    let budget = round2(i.amount + clawback);
    const covered: Types.ObjectId[] = [];
    for (const s of approved) {
      if (s.commissionAmount <= budget + 0.001) { covered.push(s._id); budget = round2(budget - s.commissionAmount); }
    }
    const payout = await Payout.create({ referrerId: rid, amount: round2(i.amount), paidOn: new Date(i.paidOn), method: i.method, transactionId: i.transactionId ?? "", note: i.note ?? "", createdBy });
    if (covered.length) {
      await Sale.updateMany({ _id: { $in: covered } }, { commissionStatus: "paid", payoutId: payout._id });
      await PayoutSale.insertMany(covered.map((saleId) => ({ payoutId: payout._id, saleId })));
    }
    if (clawbacks.length) await Sale.updateMany({ _id: { $in: clawbacks.map((s) => s._id) } }, { clawbackOpen: false });
    return { ...payout.toObject(), salesCovered: covered.length, clawbackSettled: round2(clawback) };
  },
};
