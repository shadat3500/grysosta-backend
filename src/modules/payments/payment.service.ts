import { Types } from "mongoose";
import type { z } from "zod";
import { Order } from "./order.model";
import { paymentGateway } from "./stripe.gateway";
import { Member } from "../members/member.model";
import { memberService } from "../members/member.service";
import { prepaySchema, type SignupInput } from "../members/member.schema";
import { referrerService } from "../referrers/referrer.service";
import { Referrer } from "../referrers/referrer.model";
import { Sale } from "../sales/sales.models";
import { calcCommission } from "../sales/commission";
import { salesService } from "../sales/sales.service";
import { settingsService } from "../settings/settings.service";
import { audit } from "../activity/activity.service";
import { publish } from "../../common/realtime";
import { env } from "../../config/env";
import { AppError, BadRequest, Conflict, Locked, NotFound } from "../../common/errors";
import { round2 } from "../../common/utils/money";

export type PrepayInput = z.infer<typeof prepaySchema>;
type Meta = { ipCountry: string; userAgent: string; visitorHash: string; cookieRef?: string | null };
type StripeEvent = { type: string; data: { object: Record<string, unknown> } };

export const paymentService = {
  /**
   * Prepay step 1 (client decision): 10% off, paid on GRYSOSTA.com through Stripe Checkout.
   * Locked until the admin switches Prepay on (manuals ready to ship).
   * The member stays on the VIP list until the payment succeeds; then the tier becomes "prepay".
   */
  async startPrepay(i: PrepayInput, meta: Meta) {
    const s = await settingsService.get();
    if (!s.prepayEnabled) throw Locked("Prepay opens when the manual ships. Join the VIP Priority List and we will notify you.");
    const existing = await Member.findOne({ email: i.email }, { prepaidAt: 1 }).lean();
    if (existing?.prepaidAt) throw Conflict("This email has already prepaid. Check your inbox for your confirmation.");

    const signupInput: SignupInput = { ...i, tier: "vip", joinReferral: false };
    await memberService.signup(signupInput, meta);
    const m = await Member.findOne({ email: i.email }).lean();
    if (!m) throw NotFound("Member");

    const ref = await referrerService.findActivePublic(i.refCode || meta.cookieRef);
    const buyerRef = ref && ref.memberId && String(ref.memberId) === String(m._id) ? null : ref; // no self-referral
    const amount = round2(s.vipPrice);
    const regular = round2(s.regularPrice);
    const order = await Order.create({
      memberId: m._id, email: m.email, firstName: m.firstName, lastName: m.lastName, language: m.language,
      regularPrice: regular, discount: round2(regular - amount), amount,
      referrerId: buyerRef?._id ?? null, referrerCode: buyerRef?.code ?? "",
    });
    const lang = (m.language === "es" ? "es" : "en") as "en" | "es";
    const session = await paymentGateway.get().createCheckout({
      orderId: String(order._id),
      email: m.email,
      lang,
      amountCents: Math.round(amount * 100),
      productName: "The Beginner's Guide to Stock Trading (VIP Prepay)",
      successUrl: `${env.SITE_URL}/${lang}/prepay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${env.SITE_URL}/${lang}?prepay=cancelled#prepay`,
    });
    if (!session.url) throw new AppError(502, "CHECKOUT_FAILED", "Could not start the payment. Please try again.");
    await Order.updateOne({ _id: order._id }, { stripeSessionId: session.id });
    return { url: session.url, orderId: String(order._id), amount };
  },

  /** Stripe webhook events. Each handler is idempotent: Stripe may send the same event more than once. */
  async handleEvent(event: StripeEvent) {
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        if (obj.payment_status === "paid") await this.markPaid(obj);
        return;
      case "checkout.session.expired":
        await Order.updateOne({ stripeSessionId: String(obj.id), status: "pending" }, { status: "expired" });
        return;
      case "charge.refunded": {
        const order = await Order.findOne({ stripePaymentIntentId: String(obj.payment_intent ?? "") }, { _id: 1 }).lean();
        if (order) await this.applyRefund(String(order._id));
        return;
      }
      default:
        return;
    }
  },

  /** Payment received: member → Prepay tier, one sale with the $3.50 commission (pending 30 days) if a referrer is attached. */
  async markPaid(session: Record<string, unknown>) {
    const orderId = String(session.client_reference_id ?? (session.metadata as { orderId?: string } | undefined)?.orderId ?? "");
    if (!Types.ObjectId.isValid(orderId)) return;
    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: "pending" },
      { status: "paid", paidAt: new Date(), stripeSessionId: String(session.id), stripePaymentIntentId: String(session.payment_intent ?? "") },
      { returnDocument: "after" },
    ).lean();
    if (!order) return; // already processed
    await Member.updateOne({ _id: order.memberId }, { tier: "prepay", prepaidAt: new Date() });

    const s = await settingsService.get();
    const ref = order.referrerId ? await Referrer.findById(order.referrerId, { code: 1, status: 1 }).lean() : null;
    const active = !!ref && ref.status === "active";
    const { amount } = calcCommission(order.regularPrice, order.discount, s);
    const sale = await Sale.create({
      orderId: `STRIPE-${order._id}`, platform: "stripe", saleDate: new Date(), couponCode: ref?.code ?? "", referrerId: ref?._id ?? null, quantity: 1,
      orderValue: order.regularPrice, discount: order.discount, baseAmount: round2(order.regularPrice - order.discount),
      commissionPercent: s.commissionMode === "percent" ? s.commissionPercent : 0,
      commissionAmount: active ? amount : 0,
      commissionStatus: active ? "pending" : "cancelled",
      flagged: ref && !active ? `Referrer ${ref.status} — commission $0` : "",
      buyerName: `${order.firstName} ${order.lastName.charAt(0)}.`.trim(),
    });
    await Order.updateOne({ _id: order._id }, { saleId: sale._id, referrerCode: ref?.code ?? "" });
    publish("payment", { orderId: String(order._id), amount: order.amount, referrerCode: ref?.code ?? null });
    await audit(null, "Prepay payment received", "orders", String(order._id), `$${order.amount.toFixed(2)} · ${order.firstName} ${order.lastName}`.trim());
  },

  /** Admin refund: money goes back through Stripe, then the order and its sale are updated. */
  async refund(orderId: string) {
    const order = await Order.findById(orderId).lean();
    if (!order) throw NotFound("Order");
    if (order.status !== "paid") throw BadRequest("Only paid orders can be refunded");
    if (!order.stripePaymentIntentId) throw BadRequest("This order has no Stripe payment to refund");
    await paymentGateway.get().refund(order.stripePaymentIntentId);
    return this.applyRefund(orderId);
  },

  /** Marks a paid order refunded, cancels its commission (or opens a clawback) and moves the member back to VIP if no other prepay exists. */
  async applyRefund(orderId: string) {
    const order = await Order.findOneAndUpdate({ _id: orderId, status: "paid" }, { status: "refunded", refundedAt: new Date() }, { returnDocument: "after" }).lean();
    if (!order) return null;
    if (order.saleId) {
      const sale = await Sale.findById(order.saleId, { refunded: 1 }).lean();
      if (sale && !sale.refunded) await salesService.refund(String(order.saleId));
    }
    if (!(await Order.exists({ memberId: order.memberId, status: "paid" }))) {
      await Member.updateOne({ _id: order.memberId }, { tier: "vip", prepaidAt: null });
    }
    publish("refund", { orderId: String(order._id), amount: order.amount });
    return order;
  },
};
