import { SiteContent } from "./content.model";
import { DEFAULT_CONTENT } from "./content.defaults";

type Lean = { texts: Record<string, { en: string; es: string }>; faq: { _id: string; qEn: string; qEs: string; aEn: string; aEs: string }[]; pages: Record<string, { en: string; es: string }>; images: Record<string, string> };

let cache: { at: number; value: Lean } | null = null;

export const contentService = {
  async get(): Promise<Lean> {
    if (cache && Date.now() - cache.at < 15_000) return cache.value;
    let doc = (await SiteContent.findOne({ key: "main" }).lean()) as Record<string, unknown> | null;
    if (!doc) doc = (await SiteContent.create({ key: "main", ...DEFAULT_CONTENT })).toObject({ flattenMaps: true }) as unknown as Record<string, unknown>;
    const value = { texts: (doc.texts ?? {}) as Lean["texts"], faq: (doc.faq ?? []) as unknown as Lean["faq"], pages: doc.pages as Lean["pages"], images: doc.images as Lean["images"] };
    cache = { at: Date.now(), value };
    return value;
  },
  invalidate() { cache = null; },
  async set(patch: Record<string, unknown>) {
    await SiteContent.updateOne({ key: "main" }, { $set: patch }, { upsert: true, runValidators: true });
    this.invalidate();
    return this.get();
  },
  /** SRS L-6: if Spanish is empty, show English. */
  pick(b: { en?: string; es?: string } | undefined, lang: "en" | "es") {
    if (!b) return "";
    return lang === "es" && b.es?.trim() ? b.es : b.en ?? "";
  },
};
