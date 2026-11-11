import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ok, pageMeta } from "../../common/http";
import { idParams, pagination, rangeFilter, validate } from "../../common/validate";
import { AppError, BadRequest, NotFound } from "../../common/errors";
import { signupLimiter } from "../../common/rateLimit";
import { clientIp, ipCountry, userAgent, visitorHash } from "../../common/request";
import { verifyBotToken } from "../../common/turnstile";
import { sendExport } from "../../common/utils/export";
import { audit } from "../activity/activity.service";
import { prepaySchema } from "../members/member.schema";
import { Order, ORDER_STATUSES } from "./order.model";
import { paymentGateway } from "./stripe.gateway";
import { paymentService } from "./payment.service";
import { Sale } from "../sales/sales.models";
import { round2 } from "../../common/utils/money";

const REF_COOKIE = "gsta_ref";

/* ---------- public: Prepay checkout (mounted at /public/prepay) ---------- */
export const prepayRouter = Router();

prepayRouter.post("/checkout", signupLimiter, validate(prepaySchema), async (req: Request, res: Response) => {
  if (!(await verifyBotToken(req.body.botToken, clientIp(req)))) throw BadRequest("Please try again.", { botToken: ["Please try again."] });
  const r = await paymentService.startPrepay(req.body, {
    ipCountry: ipCountry(req), userAgent: userAgent(req), visitorHash: visitorHash(req), cookieRef: req.cookies?.[REF_COOKIE],
  });
  ok(res, r, undefined, 201);
});

/** Success page: shows whether the payment has been confirmed (the webhook may arrive a few seconds later). */
prepayRouter.get("/status", validate(z.object({ session_id: z.string().min(5).max(200) }), "query"), async (req, res) => {
  const o = await Order.findOne({ stripeSessionId: String(req.query.session_id) }, { status: 1, firstName: 1, amount: 1, paidAt: 1 }).lean();
  if (!o) throw NotFound("Order");
  ok(res, { status: o.status, firstName: o.firstName, amount: o.amount, paidAt: o.paidAt });
});

/* ---------- Stripe webhook (raw body, registered in app.ts before express.json) ---------- */
export async function stripeWebhookHandler(req: Request, res: Response) {
  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = paymentGateway.get().constructEvent(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""));
  } catch (e) {
    if (e instanceof AppError) throw e; // payments not configured → 503
    return res.status(400).json({ success: false, error: { code: "BAD_SIGNATURE", message: "Invalid Stripe signature" } });
  }
  await paymentService.handleEvent(event); // throws → 500 → Stripe retries
  res.json({ received: true });
}

/* ---------- admin: orders & payments (mounted at /admin/orders) ---------- */
export const orderRouter = Router();

orderRouter.get("/summary", async (_req, res) => {
  const [byStatus, commissions] = await Promise.all([
    Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } }]),
    Sale.aggregate([{ $match: { platform: "stripe" } }, { $group: { _id: "$commissionStatus", amount: { $sum: "$commissionAmount" } } }]),
  ]);
  const by = Object.fromEntries(ORDER_STATUSES.map((s) => [s, { count: 0, amount: 0 }]));
  for (const r of byStatus) by[r._id] = { count: r.count, amount: round2(r.amount) };
  const com = Object.fromEntries(commissions.map((c) => [c._id, round2(c.amount)]));
  ok(res, {
    orders: by,
    revenue: round2(by.paid.amount),
    refunded: round2(by.refunded.amount),
    commissions: { pending: com.pending ?? 0, approved: com.approved ?? 0, paid: com.paid ?? 0, cancelled: com.cancelled ?? 0 },
  });
});

const listOrdersSchema = pagination.merge(z.object({ from: z.string().optional(), to: z.string().optional() })).extend({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().max(100).optional(),
  format: z.enum(["json", "csv", "xlsx"]).default("json"),
});

orderRouter.get("/", validate(listOrdersSchema, "query"), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listOrdersSchema>;
  const f: Record<string, unknown> = {};
  if (q.status) f.status = q.status;
  if (q.q) {
    const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    f.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }, { referrerCode: rx }];
  }
  const r = rangeFilter(q.from, q.to);
  if (r) f.createdAt = r;
  const map = (o: Record<string, any>) => ({
    id: String(o._id), createdAt: o.createdAt as Date, status: o.status as string, firstName: o.firstName as string, lastName: o.lastName as string, email: o.email as string, language: o.language as string,
    regularPrice: o.regularPrice as number, discount: o.discount as number, amount: o.amount as number, referrer: (o.referrerId as { code?: string } | null)?.code ?? o.referrerCode ?? "",
    paidAt: (o.paidAt as Date | null) ?? null, refundedAt: (o.refundedAt as Date | null) ?? null, stripeSessionId: (o.stripeSessionId as string | undefined) ?? "",
  });
  if (q.format !== "json") {
    const all = await Order.find(f).sort({ createdAt: -1 }).populate("referrerId", "code").lean();
    return sendExport(res, all.map((o) => { const { id: _id, ...r } = map(o); return { ...r, createdAt: r.createdAt.toISOString(), paidAt: r.paidAt ? r.paidAt.toISOString() : "", refundedAt: r.refundedAt ? r.refundedAt.toISOString() : "" }; }), "orders", q.format);
  }
  const [items, total] = await Promise.all([
    Order.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate("referrerId", "code").lean(),
    Order.countDocuments(f),
  ]);
  ok(res, items.map(map), pageMeta(total, q));
});

orderRouter.post("/:id/refund", validate(idParams, "params"), async (req, res) => {
  const o = await paymentService.refund(String(req.params.id));
  await audit(req, "Refunded prepay order", "orders", String(req.params.id), o ? `$${o.amount.toFixed(2)}` : "");
  ok(res, { refunded: !!o });
});
