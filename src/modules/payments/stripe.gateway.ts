import Stripe from "stripe";
import { env } from "../../config/env";
import { AppError } from "../../common/errors";

export interface CheckoutInput {
  orderId: string;
  email: string;
  lang: "en" | "es";
  amountCents: number;
  productName: string;
  successUrl: string;
  cancelUrl: string;
}

/** The only part of Stripe the app uses. Tests swap in a fake through `paymentGateway.set()`. */
export interface PaymentGateway {
  createCheckout(i: CheckoutInput): Promise<{ id: string; url: string | null }>;
  /** Verifies the webhook signature and returns the event (throws when the signature is wrong). */
  constructEvent(rawBody: Buffer, signature: string): { type: string; data: { object: Record<string, unknown> } };
  refund(paymentIntentId: string): Promise<void>;
}

let client: Stripe | null = null;
function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Online payments are not set up yet. Please try again later.");
  client ??= new Stripe(env.STRIPE_SECRET_KEY);
  return client;
}

const live: PaymentGateway = {
  async createCheckout(i) {
    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      customer_email: i.email,
      client_reference_id: i.orderId,
      metadata: { orderId: i.orderId },
      locale: i.lang,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: i.amountCents, product_data: { name: i.productName } } }],
      success_url: i.successUrl,
      cancel_url: i.cancelUrl,
    });
    return { id: session.id, url: session.url };
  },
  constructEvent(rawBody, signature) {
    if (!env.STRIPE_WEBHOOK_SECRET) throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Stripe webhook secret is not set");
    return stripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET) as unknown as { type: string; data: { object: Record<string, unknown> } };
  },
  async refund(paymentIntentId) {
    await stripe().refunds.create({ payment_intent: paymentIntentId });
  },
};

let active: PaymentGateway = live;
export const paymentGateway = {
  get: () => active,
  /** Pass null to restore the real Stripe gateway. */
  set: (g: PaymentGateway | null) => { active = g ?? live; },
};
