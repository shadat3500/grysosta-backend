import { Types } from "mongoose";
import { BuyClick, PageVisit, ReferralVisit } from "./tracking.models";
import { Referrer } from "../referrers/referrer.model";
import { dayKey } from "../../common/utils/dates";

const dupOk = (e: unknown) => { if ((e as { code?: number }).code !== 11000) throw e; };

export const trackingService = {
  /** Daily unique visitor counter (SRS A2 "Visitors today"). */
  async pageVisit(visitorHash: string, lang: "en" | "es", utmSource?: string | null) {
    await PageVisit.create({ visitorHash, visitedOn: dayKey(), lang, utmSource: utmSource ?? null }).catch(dupOk);
  },

  /** One referral visit per visitor per referrer per day (SRS 6.5). */
  async referralVisit(referrerId: Types.ObjectId, visitorHash: string, lang: "en" | "es") {
    try {
      await ReferralVisit.create({ referrerId, visitorHash, visitedOn: dayKey(), landingLang: lang });
      await Referrer.updateOne({ _id: referrerId }, { $inc: { visits: 1 } });
      return true;
    } catch (e) {
      dupOk(e);
      return false;
    }
  },

  buyClick: (referrerId: Types.ObjectId | null, lang: "en" | "es", codeShown: string) => BuyClick.create({ referrerId, lang, codeShown }),
};
