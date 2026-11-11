import { Router } from "express";
import { ok, pageMeta } from "../../common/http";
import { pagination, validate } from "../../common/validate";
import { BuyClick } from "./tracking.models";

/** Admin: Buy button clicks, newest first (used for referrer stats). */
export const buyClickRouter = Router();

buyClickRouter.get("/", validate(pagination, "query"), async (req, res) => {
  const q = req.query as unknown as { page: number; limit: number };
  const [items, total] = await Promise.all([
    BuyClick.find().sort({ clickedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    BuyClick.countDocuments(),
  ]);
  ok(res, items.map((b) => ({ id: String(b._id), referrerId: b.referrerId ? String(b.referrerId) : null, lang: b.lang, codeShown: b.codeShown, clickedAt: b.clickedAt })), pageMeta(total, q));
});
