import { Settings, type SettingsDoc } from "./settings.model";
import { BadRequest } from "../../common/errors";
import { normalizeCode } from "../../common/utils/codes";
import { round2 } from "../../common/utils/money";

let cache: { at: number; value: SettingsDoc } | null = null;
const TTL = 15_000;

export const settingsService = {
  async get(): Promise<SettingsDoc> {
    if (cache && Date.now() - cache.at < TTL) return cache.value;
    let doc = await Settings.findOne({ key: "global" }).lean();
    if (!doc) doc = (await Settings.create({ key: "global" })).toObject();
    cache = { at: Date.now(), value: doc as SettingsDoc };
    return cache.value;
  },

  invalidate() {
    cache = null;
  },

  async update(patch: Record<string, unknown>) {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "social" && v && typeof v === "object") for (const [sk, sv] of Object.entries(v)) set[`social.${sk}`] = sv;
      else set[k] = v;
    }
    const doc = await Settings.findOneAndUpdate({ key: "global" }, { $set: set }, { returnDocument: "after", upsert: true, runValidators: true }).lean();
    this.invalidate();
    return doc as SettingsDoc;
  },

  async updateSiteMode(p: { siteMode?: string; bookLinkEn?: string; bookLinkEs?: string; regularPrice?: number; vipPrice?: number; generalVipCode?: string; launchDate?: string | null; autoVipPrice?: boolean }) {
    const cur = await this.get();
    const { autoVipPrice, ...rest } = p;
    const next: Record<string, unknown> = { ...rest };
    if (rest.generalVipCode !== undefined) {
      next.generalVipCode = normalizeCode(rest.generalVipCode);
      if ((next.generalVipCode as string).length < 4) throw BadRequest("General VIP code must have at least 4 letters/numbers");
    }
    if (rest.launchDate !== undefined) next.launchDate = rest.launchDate ? new Date(rest.launchDate) : null;
    const regular = rest.regularPrice ?? cur.regularPrice;
    if (autoVipPrice) next.vipPrice = round2(regular * (1 - cur.discountPercent / 100));
    const vip = (next.vipPrice as number | undefined) ?? cur.vipPrice;
    if (vip > regular) throw BadRequest("VIP price must be lower than the regular price");
    return this.update(next);
  },
};
