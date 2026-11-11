import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { createApp } from "../src/app";
import { connectDB, disconnectDB } from "../src/config/db";
import { bootstrap } from "../src/scripts/bootstrap";
import { emailService } from "../src/modules/emails/email.service";
import { sentMail } from "../src/modules/emails/email.provider";
import { Sale } from "../src/modules/sales/sales.models";
import { Session } from "../src/modules/auth/session.model";
import { totp } from "../src/modules/auth/auth.service";
import { settingsService } from "../src/modules/settings/settings.service";
import { UPLOAD_DIR } from "../src/common/upload";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

const app = createApp();
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const API = "/api/v1";
let token = "";
const auth = () => ({ Authorization: `Bearer ${token}` });
const signup = (b: Record<string, unknown>, agent = request(app)) =>
  agent.post(`${API}/public/signup`).send({ language: "en", consent: true, joinReferral: false, ...b });

beforeAll(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  await connectDB();
  await bootstrap();
  // The referral program is locked until launch (client decision); these tests cover it, so switch it on.
  await settingsService.update({ referralEnabled: true });
});
afterAll(async () => { await mongoose.connection.dropDatabase(); await disconnectDB(); });

describe("health & 404", () => {
  it("health ok", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.db).toBe(true);
  });
  it("unknown route → 404 JSON", async () => {
    const r = await request(app).get(`${API}/nope`);
    expect(r.status).toBe(404);
    expect(r.body.success).toBe(false);
  });
});

describe("A1 admin auth", () => {
  it("rejects admin routes without a session", async () => {
    expect((await request(app).get(`${API}/admin/dashboard`)).status).toBe(401);
  });
  it("logs in", async () => {
    const r = await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" });
    expect(r.status).toBe(200);
    token = r.body.data.token;
    expect(r.headers["set-cookie"]?.[0]).toContain("gsta_admin=");
    const me = await request(app).get(`${API}/auth/me`).set(auth());
    expect(me.body.data.email).toBe("admin@grysosta.com");
  });
  it("cookie auth works too", async () => {
    const r = await request(app).get(`${API}/admin/settings`).set("Cookie", `gsta_admin=${token}`);
    expect(r.status).toBe(200);
  });
  it("expires a session after 2 hours idle", async () => {
    const t = (await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" })).body.data.token;
    await Session.updateMany({ kind: "admin" }, {}); // noop
    const { sha256 } = await import("../src/common/utils/crypto");
    await Session.updateOne({ tokenHash: sha256(t) }, { lastActiveAt: new Date(Date.now() - 121 * 60_000) });
    const r = await request(app).get(`${API}/auth/me`).set({ Authorization: `Bearer ${t}` });
    expect(r.status).toBe(401);
  });
});

describe("Registration & referral (SRS 14.2)", () => {
  let code = "";
  let refAgent: ReturnType<typeof request.agent>;

  it("validates every field on the server", async () => {
    const r = await request(app).post(`${API}/public/signup`).send({ firstName: "J", lastName: "", email: "bad", language: "fr" });
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.error.details)).toEqual(expect.arrayContaining(["firstName", "lastName", "email", "language", "consent"]));
  });

  it("saves a VIP member and queues E1", async () => {
    const r = await signup({ firstName: "Ana", lastName: "Lopez", email: " Ana.Lopez@Example.com ", language: "es" });
    expect(r.status).toBe(201);
    expect(r.body.data.kind).toBe("vip");
    expect(r.body.data.member.email).toBe("ana.lopez@example.com");
  });

  it("referral checkbox creates a unique GSTA code + link and E2", async () => {
    const r = await signup({ firstName: "John", lastName: "Smith", email: "john@example.com", joinReferral: true });
    expect(r.body.data.kind).toBe("referrer");
    code = r.body.data.code;
    expect(code).toMatch(/^GSTAJOHN\d{2}$/);
    expect(r.body.data.link).toBe(`https://grysosta.com/?ref=${code}`);
  });

  it("same email twice → already registered, no duplicate", async () => {
    const r = await signup({ firstName: "John", lastName: "Smith", email: "john@example.com" });
    expect(r.status).toBe(200);
    expect(r.body.data.kind).toBe("already");
  });

  it("existing member ticking referral is upgraded", async () => {
    const r = await signup({ firstName: "Ana", lastName: "Lopez", email: "ana.lopez@example.com", joinReferral: true, language: "es" });
    expect(r.body.data.kind).toBe("upgraded");
    expect(r.body.data.code).toMatch(/^GSTAANA\d{2}$/);
  });

  it("?ref= visit counts once per day and sets the cookie", async () => {
    refAgent = request.agent(app);
    const r1 = await refAgent.post(`${API}/public/visits`).send({ lang: "en", ref: code });
    expect(r1.body.data.referrer.firstName).toBe("John");
    expect(r1.headers["set-cookie"]?.join(";")).toContain(`gsta_ref=${code}`);
    await refAgent.post(`${API}/public/visits`).send({ lang: "en", ref: code });
    const list = await request(app).get(`${API}/admin/referrers?q=${code}`).set(auth());
    expect(list.body.data[0].stats.visits).toBe(1);
  });

  it("signup later (cookie) is linked to the referrer", async () => {
    const r = await signup({ firstName: "Maria", lastName: "Garcia", email: "maria@example.com" }, refAgent);
    expect(r.body.data.kind).toBe("vip");
    const m = await request(app).get(`${API}/admin/members?q=maria@example.com`).set(auth());
    expect(m.body.data[0].referredBy.code).toBe(code);
  });

  it("invalid code is ignored silently; self-referral is not counted", async () => {
    const bad = await request(app).get(`${API}/public/referrers/NOPE123`);
    expect(bad.status).toBe(404);
    await signup({ firstName: "Self", lastName: "Ref", email: "self@example.com", refCode: "NOPE123" });
    const self = await signup({ firstName: "John", lastName: "Smith", email: "john@example.com", refCode: code });
    expect(self.body.data.kind).toBe("already");
    const m = await request(app).get(`${API}/admin/members?q=self@example.com`).set(auth());
    expect(m.body.data[0].referredBy).toBeNull();
  });

  it("emails go out in the member's language with an unsubscribe link", async () => {
    sentMail.length = 0;
    await emailService.drain();
    const e1 = sentMail.find((m) => m.to === "maria@example.com");
    expect(e1?.subject).toContain("Welcome to the GRYSOSTA VIP Priority List, Maria");
    expect(e1?.html).toContain("unsubscribe?token=");
    const e2 = sentMail.find((m) => m.to === "ana.lopez@example.com" && m.subject.includes("código"));
    expect(e2?.subject).toContain("aquí está su código");
    expect(e2?.text).toMatch(/GSTAANA\d{2}/);
  });

  it("unsubscribe / resubscribe by token", async () => {
    const m = await mongoose.connection.collection("members").findOne({ email: "maria@example.com" });
    const u = await request(app).post(`${API}/public/unsubscribe`).send({ token: m!.unsubscribeToken });
    expect(u.body.data.status).toBe("unsubscribed");
    const r = await request(app).post(`${API}/public/resubscribe`).send({ token: m!.unsubscribeToken });
    expect(r.body.data.status).toBe("subscribed");
  });

  it("/my-referrals magic link shows the numbers", async () => {
    sentMail.length = 0;
    await request(app).post(`${API}/public/my-referrals/request`).send({ email: "john@example.com" });
    await emailService.drain();
    const link = sentMail.find((m) => m.to === "john@example.com")!.text.match(/token=([\w-]+)/)![1];
    const v = await request(app).post(`${API}/public/my-referrals/verify`).send({ token: link });
    expect(v.status).toBe(200);
    const again = await request(app).post(`${API}/public/my-referrals/verify`).send({ token: link });
    expect(again.status).toBe(400); // single use
    const d = await request(app).get(`${API}/public/my-referrals`).set({ Authorization: `Bearer ${v.body.data.token}` });
    expect(d.body.data.code).toBe(code);
    expect(d.body.data.stats.signups).toBe(1);
    expect(d.body.data.stats.visits).toBe(1);
    const p = await request(app).patch(`${API}/public/my-referrals/payout`).set({ Authorization: `Bearer ${v.body.data.token}` }).send({ payoutEmail: "john.paypal@example.com" });
    expect(p.status).toBe(200);
  });

  it("6th signup from the same IP in an hour is blocked", async () => {
    process.env.TEST_RATE_LIMIT = "1";
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await signup({ firstName: "Rate", lastName: "Limit", email: `rate${i}@example.com` }).set("X-Forwarded-For", "9.9.9.9")).status);
    delete process.env.TEST_RATE_LIMIT;
    expect(codes.at(-1)).toBe(429);
  });
});

describe("Launch mode (SRS 14.3)", () => {
  it("site config hides the buy link in pre-launch", async () => {
    const r = await request(app).get(`${API}/public/site`);
    expect(r.body.data.settings.siteMode).toBe("prelaunch");
    expect(r.body.data.settings.bookLinkEn).toBeUndefined(); // no Etsy/eBay links on the site
    expect(r.body.data.settings.prepayEnabled).toBe(false);   // Prepay locked until manuals ship
  });
  it("switches mode and sets book links / prices", async () => {
    const r = await request(app).patch(`${API}/admin/settings/site-mode`).set(auth()).send({ siteMode: "launch", bookLinkEn: "https://www.etsy.com/listing/1/en", bookLinkEs: "https://www.etsy.com/listing/2/es", regularPrice: 59.99, autoVipPrice: true });
    expect(r.body.data.vipPrice).toBe(53.99);
    expect(r.body.data.siteMode).toBe("launch");
  });
  it("buy click returns language link + referrer code, else general code; counts clicks", async () => {
    const list = await request(app).get(`${API}/admin/referrers?q=john`).set(auth());
    const code = list.body.data[0].code;
    const a = await request(app).post(`${API}/public/buy-click`).send({ lang: "es", ref: code });
    expect(a.body.data).toMatchObject({ url: null, code }); // purchases go through the Stripe checkout, not Etsy
    const b = await request(app).post(`${API}/public/buy-click`).send({ lang: "en" });
    expect(b.body.data.code).toBe("GSTAVIP10");
    const again = await request(app).get(`${API}/admin/referrers?q=john`).set(auth());
    expect(again.body.data[0].stats.clicks).toBe(1);
  });
  it("launch email E4 uses the right code per member and reports progress", async () => {
    sentMail.length = 0;
    const r = await request(app).post(`${API}/admin/emails/launch`).set(auth()).send({ audience: "all" });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 300));
    await emailService.drain();
    const log = await request(app).get(`${API}/admin/emails/logs/${r.body.data._id}`).set(auth());
    expect(log.body.data.status).toBe("done");
    expect(log.body.data.progress).toBe(100);
    const maria = sentMail.find((m) => m.to === "maria@example.com")!;
    const self = sentMail.find((m) => m.to === "self@example.com")!;
    // E4 (client copy): Prepay price on the site, no Etsy links and no coupon code any more
    expect(maria.text).toContain("$53.99");
    expect(self.text).toContain("$53.99");
    expect(sentMail.some((m) => /etsy|ebay/i.test(m.text))).toBe(false);
  });
});

describe("Sales import & commissions (SRS 14.5)", () => {
  let csv = "";
  let codes: string[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 10; i++) {
      const r = await signup({ firstName: `Ref${String.fromCharCode(65 + i)}`, lastName: "Test", email: `ref${i}@example.com`, joinReferral: true });
      codes.push(r.body.data.code);
    }
    const rows = [["Sale Date", "Order ID", "Full Name", "Number of Items", "Coupon Code", "Order Value", "Discount Amount", "Order Total"]];
    let id = 9000;
    codes.forEach((c) => rows.push(["11/02/26", String(id++), "Buyer", "1", c.toLowerCase(), "$59.99", "6.00", "53.99"]));
    for (let i = 0; i < 5; i++) rows.push(["11/02/26", String(id++), "Buyer", "1", "GSTAVIP10", "59.99", "6.00", "53.99"]);
    for (let i = 0; i < 3; i++) rows.push(["11/02/26", String(id++), "Buyer", "1", "", "59.99", "0", "59.99"]);
    rows.push(["11/02/26", String(id++), "Buyer", "1", "GSTAUNKNOWN11", "59.99", "6.00", "53.99"]);
    rows.push(["11/02/26", String(id++), "Buyer", "1", "FRIEND2026", "59.99", "6.00", "53.99"]);
    csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  });

  it("rejects non-CSV uploads", async () => {
    const r = await request(app).post(`${API}/admin/sales/import/preview`).set(auth()).attach("file", Buffer.from("x"), "orders.txt");
    expect(r.status).toBe(400);
  });

  let draftId = "";
  it("preview: 10 known, 5 general, 3 none, 2 unknown, $3.50 each", async () => {
    const r = await request(app).post(`${API}/admin/sales/import/preview`).set(auth()).attach("file", Buffer.from(csv), "EtsySoldOrders.csv");
    expect(r.status).toBe(200);
    draftId = r.body.data.draftId;
    expect(r.body.data.summary).toMatchObject({ rowsFound: 20, knownCode: 10, generalCode: 5, noCode: 3, unknownCode: 2, duplicates: 0, commissionTotal: 35 });
    expect(r.body.data.unknownCodes).toEqual(["GSTAUNKNOWN11", "FRIEND2026"]);
  });

  it("column mapping screen works when columns are renamed", async () => {
    const renamed = csv.replace('"Order ID"', '"Etsy Order #"');
    const r = await request(app).post(`${API}/admin/sales/import/preview`).set(auth()).attach("file", Buffer.from(renamed), "renamed.csv");
    expect(r.body.data.needsMapping).toBe(true);
    const a = await request(app).post(`${API}/admin/sales/import/${r.body.data.draftId}/analyze`).set(auth()).send({ mapping: { orderId: "Etsy Order #" } });
    expect(a.body.data.summary.rowsFound).toBe(20);
  });

  it("confirm saves sales; unknown code can be skipped or kept without referrer", async () => {
    const r = await request(app).post(`${API}/admin/sales/import/${draftId}/confirm`).set(auth()).send({ assignments: { GSTAUNKNOWN11: "skip", FRIEND2026: null } });
    expect(r.status).toBe(201);
    expect(r.body.data.rowsAdded).toBe(19);
    const s = await Sale.find({ couponCode: codes[0] }).lean();
    expect(s[0]).toMatchObject({ commissionAmount: 3.5, commissionStatus: "pending", baseAmount: 53.99 });
    expect(await Sale.countDocuments({ couponCode: "GSTAVIP10", referrerId: null })).toBe(5);
  });

  it("importing the same file again adds 0 rows", async () => {
    const p = await request(app).post(`${API}/admin/sales/import/preview`).set(auth()).attach("file", Buffer.from(csv), "again.csv");
    expect(p.body.data.summary.duplicates).toBe(19);
    const c = await request(app).post(`${API}/admin/sales/import/${p.body.data.draftId}/confirm`).set(auth()).send({ assignments: { GSTAUNKNOWN11: "skip" } });
    expect(c.body.data.rowsAdded).toBe(0);
  });

  it("undo last import removes those sales (the empty one), history kept", async () => {
    const u = await request(app).post(`${API}/admin/sales/imports/undo-last`).set(auth());
    expect(u.body.data.removed).toBe(0);
    const h = await request(app).get(`${API}/admin/sales/imports`).set(auth());
    expect(h.body.data[0].undone).toBe(true);
  });

  it("flat commission ($3.50 default) change affects only new sales", async () => {
    await request(app).patch(`${API}/admin/settings`).set(auth()).send({ commissionFlat: 5 });
    const m = await request(app).post(`${API}/admin/sales/manual`).set(auth()).send({ saleDate: "2026-11-02", orderId: "M-1", code: codes[1], amount: 53.99, quantity: 1 });
    expect(m.body.data.commissionAmount).toBe(5);
    expect((await Sale.findOne({ orderId: "9000" }).lean())!.commissionAmount).toBe(3.5);
    await request(app).patch(`${API}/admin/settings`).set(auth()).send({ commissionFlat: 3.5 });
  });

  it("holding period → approved; payout moves commissions to Paid", async () => {
    await Sale.updateMany({ couponCode: codes[0] }, { saleDate: new Date(Date.now() - 40 * 86_400_000) });
    await Sale.create({ orderId: "OLD-2", saleDate: new Date(Date.now() - 45 * 86_400_000), couponCode: codes[0], referrerId: (await Sale.findOne({ couponCode: codes[0] }))!.referrerId, orderValue: 59.99, discount: 6, baseAmount: 53.99, commissionPercent: 10, commissionAmount: 3.5, commissionStatus: "pending" });
    await Sale.create({ orderId: "OLD-3", saleDate: new Date(Date.now() - 45 * 86_400_000), couponCode: codes[0], referrerId: (await Sale.findOne({ couponCode: codes[0] }))!.referrerId, orderValue: 59.99, discount: 6, baseAmount: 53.99, commissionPercent: 10, commissionAmount: 3.5, commissionStatus: "pending" });
    const a = await request(app).post(`${API}/admin/sales/approve-due`).set(auth());
    expect(a.body.data.approved).toBeGreaterThanOrEqual(3);
    const sum = await request(app).get(`${API}/admin/payouts/summary?q=${codes[0]}`).set(auth());
    const row = sum.body.data[0];
    expect(row.stats.ready).toBe(10.5); // three $3.50 commissions
    expect(row.readyToPay).toBe(false); // below $20 minimum
    const p = await request(app).post(`${API}/admin/payouts`).set(auth()).send({ referrerId: row.id, amount: 10.5, paidOn: "2026-11-02", method: "PayPal", transactionId: "TX1" });
    expect(p.body.data.salesCovered).toBe(3);
    expect(await Sale.countDocuments({ couponCode: codes[0], commissionStatus: "paid" })).toBe(3);
  });

  it("refund cancels commission; paid-then-refunded creates a negative balance", async () => {
    const paid = await Sale.findOne({ couponCode: codes[0], commissionStatus: "paid" }).lean();
    const r = await request(app).post(`${API}/admin/sales/${paid!._id}/refund`).set(auth());
    expect(r.body.data.commissionStatus).toBe("cancelled");
    expect(r.body.data.clawbackOpen).toBe(true);
    const d = await request(app).get(`${API}/admin/referrers/${paid!.referrerId}`).set(auth());
    expect(d.body.data.stats.unpaid).toBe(-3.5);
  });
});

describe("Full endpoint coverage", () => {
  let announcementId = "";
  let memberId = "";

  it("A1 forgot → reset → change password (sessions signed out)", async () => {
    sentMail.length = 0;
    const unknown = await request(app).post(`${API}/auth/forgot-password`).send({ email: "nobody@example.com" });
    expect(unknown.status).toBe(200);
    await emailService.drain();
    expect(sentMail.some((m) => m.to === "nobody@example.com")).toBe(false);
    await request(app).post(`${API}/auth/forgot-password`).send({ email: "admin@grysosta.com" });
    await emailService.drain();
    const mail = sentMail.find((m) => m.to === "admin@grysosta.com");
    expect(mail).toBeDefined();
    const resetToken = mail!.text.match(/token=(\S+)/)![1];
    expect((await request(app).post(`${API}/auth/reset-password`).send({ token: "x".repeat(20), password: "NewPass123!" })).status).toBe(400);
    expect((await request(app).post(`${API}/auth/reset-password`).send({ token: resetToken, password: "NewPass123!" })).status).toBe(200);
    expect((await request(app).post(`${API}/auth/reset-password`).send({ token: resetToken, password: "Another123!" })).status).toBe(400); // single use
    expect((await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" })).status).toBe(401);
    token = (await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "NewPass123!" })).body.data.token;
    expect((await request(app).post(`${API}/auth/change-password`).set(auth()).send({ currentPassword: "nope", newPassword: "Third123!" })).status).toBe(400);
    expect((await request(app).post(`${API}/auth/change-password`).set(auth()).send({ currentPassword: "NewPass123!", newPassword: "grysosta2026" })).status).toBe(200);
    token = (await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" })).body.data.token;
    expect((await request(app).get(`${API}/auth/me`).set(auth())).body.data.email).toBe("admin@grysosta.com");
  });

  it("A1 2-step login: enable → challenge → verify → disable", async () => {
    const setup = await request(app).post(`${API}/auth/2fa/setup`).set(auth());
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl } = setup.body.data;
    expect(otpauthUrl).toContain("otpauth://totp/");
    expect((await request(app).post(`${API}/auth/2fa/enable`).set(auth()).send({ code: "000000" })).status).toBe(400);
    expect((await request(app).post(`${API}/auth/2fa/enable`).set(auth()).send({ code: totp(secret).generate() })).status).toBe(200);
    const challenge = await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" });
    expect(challenge.body.data.twoFactorRequired).toBe(true);
    expect((await request(app).post(`${API}/auth/2fa/verify`).send({ challengeToken: challenge.body.data.challengeToken, code: "000000" })).status).toBe(401);
    const v = await request(app).post(`${API}/auth/2fa/verify`).send({ challengeToken: challenge.body.data.challengeToken, code: totp(secret).generate() });
    expect(v.status).toBe(200);
    token = v.body.data.token;
    expect((await request(app).post(`${API}/auth/2fa/disable`).set(auth()).send({ code: totp(secret).generate() })).status).toBe(200);
    const plain = await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" });
    expect(plain.body.data.twoFactorRequired).toBe(false);
    token = plain.body.data.token;
  });

  it("A1 logout ends the session", async () => {
    expect((await request(app).post(`${API}/auth/logout`).set(auth())).status).toBe(200);
    expect((await request(app).get(`${API}/auth/me`).set(auth())).status).toBe(401);
    token = (await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" })).body.data.token;
  });

  it("A4 announcements: list, get, partial edit keeps other fields, image upload, delete", async () => {
    const c = await request(app).post(`${API}/admin/announcements`).set(auth()).send({ titleEn: "Edit me", titleEs: "Editame", bodyEn: "<p>Body EN</p>", bodyEs: "<p>Body ES</p>", buttonTextEn: "Go", buttonUrl: "https://example.com", status: "published" });
    announcementId = c.body.data._id;
    const list = await request(app).get(`${API}/admin/announcements`).set(auth());
    expect(list.body.data.some((a: { _id: string }) => a._id === announcementId)).toBe(true);
    expect((await request(app).get(`${API}/admin/announcements/${announcementId}`).set(auth())).body.data.effectiveStatus).toBeDefined();
    const edit = await request(app).patch(`${API}/admin/announcements/${announcementId}`).set(auth()).send({ pinned: true });
    expect(edit.body.data.pinned).toBe(true);
    expect(edit.body.data.titleEn).toBe("Edit me");          // a partial edit must not wipe untouched fields
    expect(edit.body.data.bodyEn).toBe("<p>Body EN</p>");
    expect(edit.body.data.buttonUrl).toBe("https://example.com");
    expect((await request(app).patch(`${API}/admin/announcements/${announcementId}`).set(auth()).send({ titleEn: "" })).status).toBe(400);
    const img = await request(app).post(`${API}/admin/announcements/upload-image`).set(auth()).attach("image", TINY_PNG, { filename: "a.png", contentType: "image/png" });
    expect(img.status).toBe(200);
    expect(img.body.data.url).toContain("/uploads/");
    fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(img.body.data.url)));
    expect((await request(app).post(`${API}/admin/announcements/upload-image`).set(auth())).status).toBe(400);
    expect((await request(app).post(`${API}/admin/announcements/upload-image`).set(auth()).attach("image", Buffer.from("hi"), { filename: "a.txt", contentType: "text/plain" })).status).toBe(400);
    expect((await request(app).delete(`${API}/admin/announcements/${announcementId}`).set(auth())).body.data.deleted).toBe(true);
    expect((await request(app).get(`${API}/admin/announcements/${announcementId}`).set(auth())).status).toBe(404);
  });

  it("A11 content: pages, cover upload and removal, unknown slot rejected", async () => {
    expect((await request(app).put(`${API}/admin/content/pages`).set(auth()).send({ pages: { privacy: { en: "<p>Privacy EN</p>", es: "<p>Privacidad</p>" } } })).status).toBe(200);
    const site = await request(app).get(`${API}/public/site`);
    expect(site.body.data.content.pages.privacy.en).toBe("<p>Privacy EN</p>");
    const up = await request(app).post(`${API}/admin/content/images/cover`).set(auth()).attach("image", TINY_PNG, { filename: "cover.png", contentType: "image/png" });
    expect(up.status).toBe(200);
    expect(up.body.data.images.cover).toContain("/uploads/");
    expect((await request(app).delete(`${API}/admin/content/images/cover`).set(auth())).body.data.images.cover).toBe("");
    expect((await request(app).post(`${API}/admin/content/images/nope`).set(auth()).attach("image", TINY_PNG, { filename: "x.png", contentType: "image/png" })).status).toBe(400);
    expect((await request(app).get(`${API}/admin/content`).set(auth())).body.data.texts).toBeDefined();
  });

  it("A5 members: view one, export selected, bulk unsubscribe, single unsubscribe", async () => {
    await signup({ firstName: "Lucia", lastName: "Gomez", email: "lucia@example.com", language: "es" });
    memberId = (await request(app).get(`${API}/admin/members?q=lucia@example.com`).set(auth())).body.data[0]._id;
    const one = await request(app).get(`${API}/admin/members/${memberId}`).set(auth());
    expect(one.body.data.email).toBe("lucia@example.com");
    expect(one.body.data.unsubscribeLink).toContain("/es/unsubscribe?token=");
    expect((await request(app).get(`${API}/admin/members/000000000000000000000000`).set(auth())).status).toBe(404);
    const csv = await request(app).post(`${API}/admin/members/bulk`).set(auth()).send({ action: "export", ids: [memberId], format: "csv" });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("lucia@example.com");
    expect((await request(app).post(`${API}/admin/members/bulk`).set(auth()).send({ action: "unsubscribe", ids: [memberId] })).body.data.affected).toBe(1);
    expect((await request(app).post(`${API}/admin/members/${memberId}/unsubscribe`).set(auth())).status).toBe(200);
    expect((await request(app).post(`${API}/admin/members/bulk`).set(auth()).send({ action: "nope", ids: [memberId] })).status).toBe(400);
  });

  it("A6 referrers: notes, resend welcome email, CSV/XLSX export, invalid status rejected", async () => {
    const ana = (await request(app).get(`${API}/admin/referrers?q=ana.lopez`).set(auth())).body.data[0];
    const note = await request(app).patch(`${API}/admin/referrers/${ana.id}`).set(auth()).send({ notes: "Call her Monday", payoutMethod: "PayPal", payoutEmail: "ana@example.com" });
    expect(note.body.data.notes).toBe("Call her Monday");
    expect((await request(app).post(`${API}/admin/referrers/${ana.id}/resend-email`).set(auth())).body.data.queued).toBe(true);
    expect((await request(app).get(`${API}/admin/referrers?format=csv`).set(auth())).headers["content-type"]).toContain("text/csv");
    expect((await request(app).get(`${API}/admin/referrers?format=xlsx`).set(auth())).headers["content-type"]).toContain("spreadsheetml");
    expect((await request(app).patch(`${API}/admin/referrers/${ana.id}/status`).set(auth()).send({ status: "frozen" })).status).toBe(400);
    expect((await request(app).get(`${API}/admin/referrers/000000000000000000000000`).set(auth())).status).toBe(404);
  });

  it("A8 sales: filtered list and CSV export", async () => {
    expect((await request(app).get(`${API}/admin/sales?status=pending`).set(auth())).status).toBe(200);
    const csv = await request(app).get(`${API}/admin/sales?format=csv`).set(auth());
    expect(csv.headers["content-type"]).toContain("text/csv");
  });

  it("A9 payouts: list, CSV, PayPal bulk export", async () => {
    const l = await request(app).get(`${API}/admin/payouts`).set(auth());
    expect(Array.isArray(l.body.data)).toBe(true);
    expect((await request(app).get(`${API}/admin/payouts?format=csv`).set(auth())).headers["content-type"]).toContain("text/csv");
    const pp = await request(app).get(`${API}/admin/payouts/paypal-export`).set(auth());
    expect(pp.text.split("\n")[0]).toContain("Recipient email");
  });

  it("A10 emails: one template with placeholders, preview, audiences, logs, unsubscribed export", async () => {
    const one = await request(app).get(`${API}/admin/emails/templates/E4`).set(auth());
    expect(one.body.data.key).toBe("E4");
    expect(one.body.meta.placeholders).toContain("{code}");
    expect((await request(app).get(`${API}/admin/emails/templates/E1/preview?lang=es`).set(auth())).status).toBe(200);
    expect((await request(app).get(`${API}/admin/emails/audiences`).set(auth())).body.data.all).toBeGreaterThan(0);
    const logs = await request(app).get(`${API}/admin/emails/logs`).set(auth());
    expect(logs.body.data.length).toBeGreaterThan(0);
    const one2 = await request(app).get(`${API}/admin/emails/logs/${logs.body.data[0]._id}`).set(auth());
    expect(one2.body.data.progress).toBeGreaterThanOrEqual(0);
    expect((await request(app).get(`${API}/admin/emails/unsubscribed`).set(auth())).status).toBe(200);
    expect((await request(app).get(`${API}/admin/emails/unsubscribed?format=csv`).set(auth())).headers["content-type"]).toContain("text/csv");
  });

  it("A12 settings: read, update, social links, site mode switch", async () => {
    const g = await request(app).get(`${API}/admin/settings`).set(auth());
    const originalMin = g.body.data.minPayout;
    const p = await request(app).patch(`${API}/admin/settings`).set(auth()).send({ minPayout: 25, social: { instagram: "https://instagram.com/grysosta" } });
    expect(p.body.data.minPayout).toBe(25);
    expect(p.body.data.social.instagram).toBe("https://instagram.com/grysosta");
    await request(app).patch(`${API}/admin/settings`).set(auth()).send({ minPayout: originalMin });
    expect((await request(app).patch(`${API}/admin/settings/site-mode`).set(auth()).send({ siteMode: "prelaunch" })).status).toBe(200);
    expect((await request(app).get(`${API}/public/site`)).body.data.settings.bookLinkEn).toBeUndefined();
    expect((await request(app).patch(`${API}/admin/settings/site-mode`).set(auth()).send({ siteMode: "launch" })).status).toBe(200);
  });

  it("/my-referrals: unknown email gets a generic reply; magic link → verify → payout email → logout", async () => {
    const generic = await request(app).post(`${API}/public/my-referrals/request`).send({ email: "nobody@example.com" });
    expect(generic.status).toBe(200);
    const john = (await request(app).get(`${API}/admin/referrers?q=john@example.com`).set(auth())).body.data[0];
    const req1 = await request(app).post(`${API}/public/my-referrals/request`).send({ email: "john@example.com", lang: "en" });
    sentMail.length = 0;
    await emailService.drain();
    const mt = sentMail.find((m) => m.to === "john@example.com")!.text.match(/token=([\w-]+)/)![1];
    expect(req1.status).toBe(200);
    const v = await request(app).post(`${API}/public/my-referrals/verify`).send({ token: mt });
    expect(v.status).toBe(200);
    const bearer = { Authorization: `Bearer ${v.body.data.token}` };
    expect((await request(app).get(`${API}/public/my-referrals`).set(bearer)).body.data.code).toBe(john.code);
    expect((await request(app).post(`${API}/public/my-referrals/verify`).send({ token: mt })).status).toBe(400);
    expect((await request(app).patch(`${API}/public/my-referrals/payout`).set(bearer).send({ payoutEmail: "nope" })).status).toBe(400);
    expect((await request(app).patch(`${API}/public/my-referrals/payout`).set(bearer).send({ payoutEmail: "john.paypal@example.com" })).body.data.payoutEmail).toBe("john.paypal@example.com");
    expect((await request(app).post(`${API}/public/my-referrals/logout`).set(bearer)).status).toBe(200);
    expect((await request(app).get(`${API}/public/my-referrals`).set(bearer)).status).toBe(401);
  });
});

describe("Live updates (SSE) for the admin panel", () => {
  it("streams signups, visits and admin changes to an open admin session", async () => {
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    let status = 0;
    let body = "";
    const stream = http.get({ host: "127.0.0.1", port, path: `${API}/admin/events`, headers: { Cookie: `gsta_admin=${token}` } }, (res) => {
      status = res.statusCode ?? 0;
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
    });
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 30));
      expect(check()).toBe(true);
    };
    await waitFor(() => body.includes(": connected"));
    expect(status).toBe(200);

    await signup({ firstName: "Live", lastName: "Viewer", email: "live@example.com", language: "en" });
    await request(app).post(`${API}/public/visits`).send({ lang: "en" });
    await request(app).patch(`${API}/admin/settings`).set(auth()).send({ minPayout: 20 });

    await waitFor(() => body.includes("event: signup") && body.includes("event: visit") && body.includes("event: activity"));
    expect(body).toContain('"kind":"vip"');
    expect(body).toContain('"action":"Updated settings"');
    stream.destroy();
    await new Promise((r) => server.close(r));
  });

  it("rejects the stream without an admin session", async () => {
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve) => {
      const s = http.get({ host: "127.0.0.1", port, path: `${API}/admin/events` }, (res) => { resolve(res.statusCode ?? 0); res.resume(); });
    });
    expect(status).toBe(401);
    await new Promise((r) => server.close(r));
  });
});

describe("Admin modules", () => {
  it("A2 dashboard", async () => {
    const r = await request(app).get(`${API}/admin/dashboard`).set(auth());
    expect(r.body.data.cards.totalMembers).toBeGreaterThan(10);
    expect(r.body.data.signupsPerDay).toHaveLength(30);
    expect(r.body.data.siteMode).toBe("launch");
  });

  it("A4 announcements: schedule, reorder, public visibility, email", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const a = await request(app).post(`${API}/admin/announcements`).set(auth()).send({ titleEn: "Tomorrow", bodyEn: "<p onclick='x()'>Hi <script>alert(1)</script><b>there</b></p>", status: "published", startsAt: tomorrow });
    expect(a.body.data.status).toBe("scheduled");
    expect(a.body.data.bodyEn).toBe("<p>Hi <b>there</b></p>");
    const b = await request(app).post(`${API}/admin/announcements`).set(auth()).send({ titleEn: "Live now", titleEs: "Ya", bodyEn: "x", status: "published", pinned: true });
    const site = await request(app).get(`${API}/public/site`);
    const titles = site.body.data.announcements.map((x: { titleEn: string }) => x.titleEn);
    expect(titles).toContain("Live now");
    expect(titles).not.toContain("Tomorrow");
    const re = await request(app).patch(`${API}/admin/announcements/reorder`).set(auth()).send({ ids: [b.body.data._id, a.body.data._id] });
    expect(re.status).toBe(200);
    const e = await request(app).post(`${API}/admin/announcements/${b.body.data._id}/email`).set(auth()).send({ audience: "es" });
    expect(e.status).toBe(202);
  });

  it("A5 members: filter, paginate, export CSV with BOM, edit, delete", async () => {
    const r = await request(app).get(`${API}/admin/members?language=es&limit=2`).set(auth());
    expect(r.body.meta.limit).toBe(2);
    expect(r.body.data.every((m: { language: string }) => m.language === "es")).toBe(true);
    const csv = await request(app).get(`${API}/admin/members?format=csv`).set(auth());
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    const x = await request(app).get(`${API}/admin/members?format=xlsx`).set(auth());
    expect(x.headers["content-type"]).toContain("spreadsheetml");
    const self = (await request(app).get(`${API}/admin/members?q=self@example.com`).set(auth())).body.data[0];
    const p = await request(app).patch(`${API}/admin/members/${self._id}`).set(auth()).send({ language: "es" });
    expect(p.body.data.language).toBe("es");
    const mr = await request(app).post(`${API}/admin/members/${self._id}/make-referrer`).set(auth());
    expect(mr.body.data.code).toMatch(/^GSTASELF\d{2}$/);
    const del = await request(app).delete(`${API}/admin/members/${self._id}`).set(auth());
    expect(del.body.data.deleted).toBe(true);
    // code is retired, never reused
    const reuse = await request(app).get(`${API}/public/referrers/${mr.body.data.code}`);
    expect(reuse.status).toBe(404);
  });

  it("A6 referrers: sort, pause ignores link, edit code unique", async () => {
    const r = await request(app).get(`${API}/admin/referrers?sort=-signups`).set(auth());
    const john = r.body.data.find((x: { email: string }) => x.email === "john@example.com");
    const ana = r.body.data.find((x: { email: string }) => x.email === "ana.lopez@example.com");
    await request(app).patch(`${API}/admin/referrers/${john.id}/status`).set(auth()).send({ status: "paused" });
    expect((await request(app).get(`${API}/public/referrers/${john.code}`)).status).toBe(404);
    await request(app).patch(`${API}/admin/referrers/${john.id}/status`).set(auth()).send({ status: "active" });
    const dup = await request(app).patch(`${API}/admin/referrers/${john.id}/code`).set(auth()).send({ code: ana.code });
    expect(dup.status).toBe(409);
    const ok = await request(app).patch(`${API}/admin/referrers/${john.id}/code`).set(auth()).send({ code: "gsta-johnny 1" });
    expect(ok.body.data.code).toBe("GSTAJOHNNY1");
    const detail = await request(app).get(`${API}/admin/referrers/${john.id}`).set(auth());
    expect(detail.body.data.referred.length).toBe(1);
  });

  it("A7 etsy codes: sorted by signups, bulk mark", async () => {
    const r = await request(app).get(`${API}/admin/etsy-codes?created=false`).set(auth());
    expect(r.body.data.length).toBeGreaterThan(0);
    const m = await request(app).post(`${API}/admin/etsy-codes/mark`).set(auth()).send({ ids: [r.body.data[0].id], created: true });
    expect(m.body.data.updated).toBe(1);
  });

  it("A10 emails: templates, edit, test send", async () => {
    const t = await request(app).get(`${API}/admin/emails/templates`).set(auth());
    expect(t.body.data.map((x: { key: string }) => x.key)).toEqual(["E1", "E2", "E3", "E4", "E5", "E6", "E7"]);
    await request(app).put(`${API}/admin/emails/templates/E1`).set(auth()).send({ subjectEn: "Hello {first_name}!" });
    sentMail.length = 0;
    const s = await request(app).post(`${API}/admin/emails/templates/E1/test`).set(auth()).send({ lang: "en" });
    expect(s.body.data.subject).toBe("Hello John!");
    expect(sentMail[0].to).toBe("admin@grysosta.com");
  });

  it("A11 content: texts, FAQ, pages (EN/ES)", async () => {
    const t = await request(app).put(`${API}/admin/content/texts`).set(auth()).send({ texts: { heroHeadline: { en: "LEARN. TRADE. GROW!", es: "" } } });
    expect(t.body.data.texts.heroHeadline.en).toBe("LEARN. TRADE. GROW!");
    const f = await request(app).put(`${API}/admin/content/faq`).set(auth()).send({ faq: [{ qEn: "Q1?", aEn: "A1" }] });
    expect(f.body.data.faq).toHaveLength(1);
    const site = await request(app).get(`${API}/public/site`);
    expect(site.body.data.content.texts.heroHeadline.en).toBe("LEARN. TRADE. GROW!");
  });

  it("A12 settings validation", async () => {
    const bad = await request(app).patch(`${API}/admin/settings`).set(auth()).send({ commissionPercent: 80 });
    expect(bad.status).toBe(400);
    const unknown = await request(app).patch(`${API}/admin/settings`).set(auth()).send({ siteMode: "launch" });
    expect(unknown.status).toBe(400); // strict: site mode only via /site-mode
  });

  it("A13 reports, signups by source and activity log", async () => {
    for (const ds of ["members", "referrers", "sales", "commissions", "payouts", "activity"]) {
      const r = await request(app).get(`${API}/admin/reports/export/${ds}?format=csv&lang=en`).set(auth());
      expect(r.status).toBe(200);
    }
    const s = await request(app).get(`${API}/admin/reports/signups-by-source`).set(auth());
    expect(s.body.data.find((x: { source: string }) => x.source === "referral")?.signups).toBeGreaterThan(0);
    const a = await request(app).get(`${API}/admin/activity?q=Recorded%20payout`).set(auth());
    expect(a.body.data[0].action).toBe("Recorded payout");
    expect(a.body.data[0].adminName).toBe("Georgino Perez");
  });

  it("locks the account for 15 minutes after 5 wrong passwords", async () => {
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "wrong" })).status;
    expect(last).toBe(423);
    const right = await request(app).post(`${API}/auth/login`).send({ email: "admin@grysosta.com", password: "grysosta2026" });
    expect(right.status).toBe(423);
  });
});
