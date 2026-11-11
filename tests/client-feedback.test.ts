import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { createApp } from "../src/app";
import { connectDB, disconnectDB } from "../src/config/db";
import { bootstrap } from "../src/scripts/bootstrap";
import { settingsService } from "../src/modules/settings/settings.service";
import { Member } from "../src/modules/members/member.model";
import { Order } from "../src/modules/payments/order.model";
import { paymentGateway, type PaymentGateway } from "../src/modules/payments/stripe.gateway";
import { Sale } from "../src/modules/sales/sales.models";
import { EmailJob } from "../src/modules/emails/email.models";
import { Referrer } from "../src/modules/referrers/referrer.model";

/* Client feedback (Georgino Perez): Prepay on the site via Stripe, Reserve / VIP tiers, flat $3.50 referral
   commission (locked until launch), purchase invitations in batches, and admin controls. */

const app = createApp();
const API = "/api/v1";
let token = "";
const auth = () => ({ Authorization: `Bearer ${token}` });
const sessions = new Map<string, string>(); // checkout session id → order id
const refunds: string[] = [];

const fakeStripe: PaymentGateway = {
  async createCheckout(i) {
    const id = `cs_test_${i.orderId}`;
    sessions.set(id, i.orderId);
    return { id, url: `https://checkout.stripe.test/${id}` };
  },
  constructEvent(raw) {
    return JSON.parse(raw.toString()); // real Stripe verifies the signature here
  },
  async refund(pi) {
    refunds.push(pi);
  },
};

const signup = (b: Record<string, unknown>) =>
  request(app).post(`${API}/public/signup`).send({ language: "en", consent: true, ...b });
const prepay = (b: Record<string, unknown>) =>
  request(app).post(`${API}/public/prepay/checkout`).send({ language: "en", consent: true, ...b });
const hook = (type: string, object: Record<string, unknown>) =>
  request(app).post(`${API}/public/stripe/webhook`).set("Content-Type", "application/json").send(JSON.stringify({ type, data: { object } }));
const paidEvent = (sessionId: string, paymentIntent = `pi_${sessionId}`) =>
  hook("checkout.session.completed", { id: sessionId, payment_status: "paid", payment_intent: paymentIntent, client_reference_id: sessions.get(sessionId) });
const setFeatures = (b: { prepayEnabled?: boolean; referralEnabled?: boolean }) => request(app).patch(`${API}/admin/settings/features`).set(auth()).send(b);

beforeAll(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  await connectDB();
  await bootstrap();
  paymentGateway.set(fakeStripe);
  token = (await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" })).body.data.token;
});
afterAll(async () => {
  paymentGateway.set(null);
  await mongoose.connection.dropDatabase();
  await disconnectDB();
});

describe("Launch locks (client: Prepay and referrals stay locked until the manuals ship)", () => {
  it("defaults: Prepay off, referral program off, commission $3.50 flat", async () => {
    const s = (await request(app).get(`${API}/public/site`)).body.data.settings;
    expect(s).toMatchObject({ prepayEnabled: false, referralEnabled: false, commissionMode: "flat", commissionFlat: 3.5 });
    expect(s.bookLinkEn).toBeUndefined(); // no Etsy/eBay links
  });

  it("prepay checkout is refused while Prepay is locked", async () => {
    const r = await prepay({ firstName: "Early", lastName: "Bird", email: "early@example.com" });
    expect(r.status).toBe(423);
    expect(await Order.countDocuments({ email: "early@example.com" })).toBe(0);
  });

  it("referral checkbox is ignored while locked: plain VIP member, no referrer created", async () => {
    const r = await signup({ firstName: "Lock", lastName: "Test", email: "lock@example.com", joinReferral: true });
    expect(r.body.data.kind).toBe("vip");
    expect(await Referrer.countDocuments({ "memberId": (await Member.findOne({ email: "lock@example.com" }))!._id })).toBe(0);
  });

  it("admin cannot create a referrer while the program is locked", async () => {
    const m = await Member.findOne({ email: "lock@example.com" }).lean();
    const r = await request(app).post(`${API}/admin/members/${m!._id}/make-referrer`).set(auth());
    expect(r.status).toBe(423);
  });

  it("the referral dashboard and magic links are closed while locked", async () => {
    const r = await request(app).post(`${API}/public/my-referrals/request`).send({ email: "lock@example.com" });
    expect(r.body.data.devMagicToken).toBeUndefined();
    const v = await request(app).post(`${API}/public/my-referrals/verify`).send({ token: "x".repeat(20) });
    expect(v.status).toBe(423);
  });

  it("feature switches are logged and change the public site", async () => {
    expect((await setFeatures({ prepayEnabled: true })).body.data.prepayEnabled).toBe(true);
    expect((await request(app).get(`${API}/public/site`)).body.data.settings.prepayEnabled).toBe(true);
    const acts = await request(app).get(`${API}/admin/activity?q=Prepay%20turned`).set(auth());
    expect(acts.body.data.some((a: { action: string }) => a.action === "Prepay turned ON")).toBe(true);
    await setFeatures({ referralEnabled: true });
  });
});

describe("Three sign-up options with priority (Prepay → Reserve → VIP)", () => {
  it("reserve: name + email, no payment, stored as Reserve", async () => {
    const r = await signup({ firstName: "Rita", lastName: "Reserve", email: "rita@example.com", tier: "reserve" });
    expect(r.status).toBe(201);
    expect(r.body.data.kind).toBe("reserve");
    expect((await Member.findOne({ email: "rita@example.com" }).lean())!.tier).toBe("reserve");
  });

  it("VIP list is the default option", async () => {
    await signup({ firstName: "Vic", lastName: "Viewer", email: "vic@example.com" });
    expect((await Member.findOne({ email: "vic@example.com" }).lean())!.tier).toBe("vip");
  });

  it("a VIP can upgrade to Reserve, but never downgrade", async () => {
    await signup({ firstName: "Vic", lastName: "Viewer", email: "vic@example.com", tier: "reserve" });
    expect((await Member.findOne({ email: "vic@example.com" }).lean())!.tier).toBe("reserve");
    await signup({ firstName: "Vic", lastName: "Viewer", email: "vic@example.com", tier: "vip" });
    expect((await Member.findOne({ email: "vic@example.com" }).lean())!.tier).toBe("reserve");
  });

  it("the public signup cannot choose Prepay (that needs the checkout)", async () => {
    const r = await signup({ firstName: "Pat", lastName: "Pay", email: "pat@example.com", tier: "prepay" });
    expect(r.status).toBe(400);
  });

  it("groups endpoint and tier filter split the registrations", async () => {
    const g = await request(app).get(`${API}/admin/members/groups`).set(auth());
    expect(g.body.data.reserve.total).toBeGreaterThanOrEqual(2);
    expect(g.body.data.vip.total).toBeGreaterThanOrEqual(1);
    const f = await request(app).get(`${API}/admin/members?tier=reserve&format=json`).set(auth());
    expect(f.body.meta.total).toBe(g.body.data.reserve.total);
    expect(f.body.data.every((m: { tier: string }) => m.tier === "reserve")).toBe(true);
  });

  it("admin can move a member between groups", async () => {
    const m = await Member.findOne({ email: "rita@example.com" }).lean();
    const r = await request(app).patch(`${API}/admin/members/${m!._id}`).set(auth()).send({ tier: "vip" });
    expect(r.body.data.tier).toBe("vip");
  });
});

describe("Prepay: 10% off, paid on GRYSOSTA.com through Stripe", () => {
  it("creates a pending order at $53.99 (was $59.99) and returns the checkout link", async () => {
    const r = await prepay({ firstName: "Paula", lastName: "Prepay", email: "paula@example.com" });
    expect(r.status).toBe(201);
    expect(r.body.data.url).toContain("checkout.stripe.test");
    expect(r.body.data.amount).toBe(53.99);
    const o = await Order.findById(r.body.data.orderId).lean();
    expect(o).toMatchObject({ status: "pending", amount: 53.99, regularPrice: 59.99, discount: 6 });
    // still on the VIP list until the payment is confirmed
    expect((await Member.findOne({ email: "paula@example.com" }).lean())!.tier).toBe("vip");
  });

  it("success page can poll the status by Stripe session id", async () => {
    const o = await Order.findOne({ email: "paula@example.com" }).lean();
    const st = await request(app).get(`${API}/public/prepay/status?session_id=cs_test_${o!._id}`);
    expect(st.body.data).toMatchObject({ status: "pending", firstName: "Paula" });
  });

  it("a bad webhook signature is rejected", async () => {
    const r = await request(app).post(`${API}/public/stripe/webhook`).set("Content-Type", "application/json").send("not json");
    expect(r.status).toBe(400);
  });

  it("payment confirmed → Prepay tier, one sale, no commission without a referrer, idempotent", async () => {
    const o = await Order.findOne({ email: "paula@example.com" }).lean();
    const sid = `cs_test_${o!._id}`;
    expect((await paidEvent(sid)).status).toBe(200);
    expect((await paidEvent(sid)).status).toBe(200); // Stripe retries the same event
    const after = await Order.findById(o!._id).lean();
    expect(after).toMatchObject({ status: "paid" });
    const m = await Member.findOne({ email: "paula@example.com" }).lean();
    expect(m).toMatchObject({ tier: "prepay" });
    expect(m!.prepaidAt).toBeTruthy();
    expect(await Sale.countDocuments({ orderId: `STRIPE-${o!._id}` })).toBe(1);
    expect(await Sale.findOne({ orderId: `STRIPE-${o!._id}` }).lean()).toMatchObject({ platform: "stripe", commissionStatus: "cancelled", commissionAmount: 0 });
  });

  it("the same email cannot prepay twice", async () => {
    const r = await prepay({ firstName: "Paula", lastName: "Prepay", email: "paula@example.com" });
    expect(r.status).toBe(409);
  });
});

describe("Referral commission: $3.50 per sale, pending 30 days", () => {
  let code = "";
  it("a referrer buys through their link → $3.50 pending commission", async () => {
    await setFeatures({ referralEnabled: true });
    const ref = await signup({ firstName: "Ron", lastName: "Referrer", email: "ron@example.com", joinReferral: true });
    code = ref.body.data.code;
    expect(code).toBeTruthy();
    const r = await prepay({ firstName: "Buyer", lastName: "Sale", email: "buyer@example.com", refCode: code });
    const o = await Order.findById(r.body.data.orderId).lean();
    expect(o!.referrerCode).toBe(code);
    await paidEvent(`cs_test_${o!._id}`);
    const sale = await Sale.findOne({ orderId: `STRIPE-${o!._id}` }).lean();
    expect(sale).toMatchObject({ commissionAmount: 3.5, commissionStatus: "pending", baseAmount: 53.99 });
  });

  it("the referrer dashboard shows the balance", async () => {
    const list = await request(app).get(`${API}/admin/referrers?q=ron`).set(auth());
    expect(list.body.data[0].stats).toMatchObject({ sales: 1, pending: 3.5, earned: 3.5 });
  });

  it("monthly payout totals group the payments by month", async () => {
    const ron = await Referrer.findOne({ code }).lean();
    await request(app).post(`${API}/admin/payouts`).set(auth()).send({ referrerId: String(ron!._id), amount: 7, paidOn: "2026-03-05", method: "PayPal" });
    const m = await request(app).get(`${API}/admin/payouts/monthly`).set(auth());
    expect(m.body.data).toContainEqual({ month: "2026-03", amount: 7, payouts: 1 });
  });
});

describe("Orders & payments (admin)", () => {
  it("lists orders with status filter, summary and CSV export", async () => {
    const all = await request(app).get(`${API}/admin/orders`).set(auth());
    expect(all.body.meta.total).toBeGreaterThanOrEqual(2);
    const paid = await request(app).get(`${API}/admin/orders?status=paid`).set(auth());
    expect(paid.body.data.every((o: { status: string }) => o.status === "paid")).toBe(true);
    const s = await request(app).get(`${API}/admin/orders/summary`).set(auth());
    expect(s.body.data.revenue).toBeGreaterThanOrEqual(107.98);
    const csv = await request(app).get(`${API}/admin/orders?format=csv`).set(auth());
    expect(csv.text.split("\n")[0]).toContain("email");
  });

  it("refund: Stripe refund, order refunded, sale cancelled, member back to VIP; a repeat webhook is a no-op", async () => {
    const o = await Order.findOne({ email: "buyer@example.com" }).lean();
    const r = await request(app).post(`${API}/admin/orders/${o!._id}/refund`).set(auth());
    expect(r.status).toBe(200);
    expect(refunds).toContain(`pi_cs_test_${o!._id}`);
    expect((await Order.findById(o!._id).lean())!.status).toBe("refunded");
    expect(await Sale.findOne({ orderId: `STRIPE-${o!._id}` }).lean()).toMatchObject({ refunded: true, commissionStatus: "cancelled" });
    expect((await Member.findOne({ email: "buyer@example.com" }).lean())!.tier).toBe("vip");
    const again = await hook("charge.refunded", { payment_intent: `pi_cs_test_${o!._id}` });
    expect(again.status).toBe(200);
    expect((await Order.findById(o!._id).lean())!.status).toBe("refunded");
  });

  it("only paid orders can be refunded", async () => {
    const o = await Order.findOne({ email: "paula@example.com" }).lean();
    await request(app).post(`${API}/admin/orders/${o!._id}/refund`).set(auth()); // paid → refunded
    const r = await request(app).post(`${API}/admin/orders/${o!._id}/refund`).set(auth());
    expect(r.status).toBe(400);
  });
});

describe("Purchase invitations (admin controls the groups and the batch size)", () => {
  it("nothing is sent while Prepay is locked", async () => {
    await setFeatures({ prepayEnabled: false });
    const r = await request(app).post(`${API}/admin/invitations/send`).set(auth()).send({ groups: ["reserve"] });
    expect(r.status).toBe(423);
    await setFeatures({ prepayEnabled: true });
  });

  it("sends in priority order (Reserve first) and never more than the batch size", async () => {
    // Make sure there are enough people to test the cap.
    for (let i = 0; i < 4; i++) await signup({ firstName: ["Alpha", "Bravo", "Charlie", "Delta"][i], lastName: "Reserve", email: `batch-r${i}@example.com`, tier: "reserve" });
    for (let i = 0; i < 4; i++) await signup({ firstName: ["Echo", "Foxtrot", "Golf", "Hotel"][i], lastName: "Vip", email: `batch-v${i}@example.com` });
    const before = await EmailJob.countDocuments({ templateKey: "E7" });
    const first = await request(app).post(`${API}/admin/invitations/send`).set(auth()).send({ groups: ["reserve", "vip"], batchSize: 5 });
    expect(first.body.data.invited).toBe(5);
    expect(first.body.data.byGroup.reserve).toBeGreaterThanOrEqual(5); // reserve group comes first
    expect(first.body.data.byGroup.vip).toBe(0);
    expect(await EmailJob.countDocuments({ templateKey: "E7" })).toBe(before + 5);
  });

  it("already invited people are not invited again; the next batch continues", async () => {
    const r = await request(app).post(`${API}/admin/invitations/send`).set(auth()).send({ groups: ["reserve", "vip"], batchSize: 100 });
    expect(r.body.data.remaining).toBe(0);
    const again = await request(app).post(`${API}/admin/invitations/send`).set(auth()).send({ groups: ["reserve", "vip"] });
    expect(again.body.data.invited).toBe(0);
    const sum = await request(app).get(`${API}/admin/invitations/summary`).set(auth());
    expect(sum.body.data.groups.reserve.waiting).toBe(0);
    expect(sum.body.data.inviteBatchSize).toBe(50);
  });

  it("unsubscribed members are never invited", async () => {
    await Member.updateOne({ email: "batch-v0@example.com" }, { invitedAt: null, status: "unsubscribed" });
    const r = await request(app).post(`${API}/admin/invitations/send`).set(auth()).send({ groups: ["vip"], batchSize: 100 });
    expect(r.body.data.invited).toBe(0);
  });

  it("the batch size can be set in settings", async () => {
    const s = await request(app).patch(`${API}/admin/settings`).set(auth()).send({ inviteBatchSize: 20 });
    expect(s.body.data.inviteBatchSize).toBe(20);
    await settingsService.update({ inviteBatchSize: 50 });
  });
});

describe("Settings for the client's rules", () => {
  it("flat commission amount can be changed; the referral % rule can still be selected", async () => {
    expect((await request(app).patch(`${API}/admin/settings`).set(auth()).send({ commissionFlat: 4 })).body.data.commissionFlat).toBe(4);
    await request(app).patch(`${API}/admin/settings`).set(auth()).send({ commissionFlat: 3.5 });
    expect((await request(app).patch(`${API}/admin/settings`).set(auth()).send({ commissionMode: "percent" })).body.data.commissionMode).toBe("percent");
    await request(app).patch(`${API}/admin/settings`).set(auth()).send({ commissionMode: "flat" });
  });

  it("email E7 (purchase invitation) is available for editing", async () => {
    const t = await request(app).get(`${API}/admin/emails/templates/E7`).set(auth());
    expect(t.body.data.name).toBe("Purchase invitation");
  });
});
