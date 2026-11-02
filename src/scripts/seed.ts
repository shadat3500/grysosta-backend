/**
 * npm run seed        → default settings, content, email templates, first admin (from .env)
 * npm run seed:demo   → + sample members, referrers, sales, payouts, announcements (wipes demo collections first)
 */
import "../app";
import { connectDB, disconnectDB } from "../config/db";
import { bootstrap } from "./bootstrap";
import { Member } from "../modules/members/member.model";
import { Referrer } from "../modules/referrers/referrer.model";
import { Sale, Import } from "../modules/sales/sales.models";
import { Payout, PayoutSale } from "../modules/payouts/payout.model";
import { Announcement } from "../modules/announcements/announcement.model";
import { BuyClick, PageVisit } from "../modules/tracking/tracking.models";
import { calcCommission } from "../modules/sales/commission";
import { settingsService } from "../modules/settings/settings.service";
import { randomToken } from "../common/utils/crypto";
import { round2 } from "../common/utils/money";
import { dayKey } from "../common/utils/dates";
import { logger } from "../config/logger";

const FIRST = ["John", "Maria", "Carlos", "Ashley", "Luis", "Jennifer", "Miguel", "Sarah", "Jose", "Emily", "David", "Ana", "Michael", "Sofia", "Daniel", "Jessica", "Jorge", "Laura", "Kevin", "Gabriela", "Brian", "Isabel", "Robert", "Camila", "Valeria", "Lucia", "Marcus", "Elena", "Tyler", "Rosa"];
const LAST = ["Smith", "Garcia", "Johnson", "Martinez", "Brown", "Rodriguez", "Williams", "Hernandez", "Lopez", "Davis", "Gonzalez", "Perez", "Sanchez", "Ramirez", "Torres", "Flores", "Rivera", "Gomez"];
const SPANISH = new Set(["Maria", "Carlos", "Luis", "Miguel", "Jose", "Ana", "Sofia", "Jorge", "Gabriela", "Isabel", "Camila", "Valeria", "Lucia", "Elena", "Rosa"]);
const SOURCES: [string | null, string | null, string | null][] = [["facebook", "paid", "vip_launch"], ["facebook", "paid", "retarget"], ["instagram", "social", "bio_link"], ["flyer", "qr", "houston_expo"], [null, null, null], ["google", "organic", null]];

let seed = 20261102;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const ago = (d: number) => new Date(Date.now() - d * 86_400_000 - Math.floor(rnd() * 80_000_000));

async function demo() {
  await Promise.all([Member, Referrer, Sale, Import, Payout, PayoutSale, Announcement, BuyClick, PageVisit].map((m) => (m as typeof Member).deleteMany({})));
  const s = await settingsService.get();
  const members = [];
  const used = new Set<string>();
  for (let i = 0; i < 260; i++) {
    const f = pick(FIRST), l = pick(LAST);
    let email = `${f}.${l}${Math.floor(rnd() * 900 + 10)}@example.com`.toLowerCase();
    while (used.has(email)) email = email.replace("@", "1@");
    used.add(email);
    const [us, um, uc] = pick(SOURCES);
    const createdAt = ago(Math.floor(Math.pow(rnd(), 1.6) * 45));
    members.push({ firstName: f, lastName: l, email, language: SPANISH.has(f) ? (rnd() < 0.8 ? "es" : "en") : rnd() < 0.15 ? "es" : "en", status: rnd() < 0.04 ? "unsubscribed" : "subscribed", unsubscribeToken: randomToken(24), consentAt: createdAt, createdAt, ipCountry: "US", utmSource: us, utmMedium: um, utmCampaign: uc });
  }
  members.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const docs = await Member.insertMany(members);
  const refDocs = [];
  const codes = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const m = docs[Math.floor(rnd() * 200)];
    if (m.isReferrer) continue;
    m.isReferrer = true;
    let code;
    do code = `GSTA${m.firstName.toUpperCase().slice(0, 8)}${String(Math.floor(rnd() * 100)).padStart(2, "0")}`; while (codes.has(code));
    codes.add(code);
    refDocs.push({ memberId: m._id, code, status: i === 6 ? "paused" : i === 12 ? "blocked" : "active", etsyCreated: rnd() < 0.45, payoutEmail: rnd() < 0.6 ? m.email : "", visits: Math.floor(rnd() * 80), createdAt: m.createdAt });
  }
  await Member.bulkWrite(docs.filter((d) => d.isReferrer).map((d) => ({ updateOne: { filter: { _id: d._id }, update: { isReferrer: true } } })));
  const refs = await Referrer.insertMany(refDocs);
  const refByMember = new Map(refs.map((r) => [String(r.memberId), r]));
  const weights = refs.map(() => Math.pow(rnd(), 3));
  const pickRef = () => { let x = rnd() * weights.reduce((a, b) => a + b, 0); for (let i = 0; i < refs.length; i++) { x -= weights[i]; if (x <= 0) return refs[i]; } return refs[0]; };
  const updates = [];
  for (const m of docs) {
    if (rnd() < 0.42) {
      const r = pickRef();
      const owner = docs.find((d) => String(d._id) === String(r.memberId))!;
      if (owner._id.toString() !== m._id.toString() && owner.createdAt < m.createdAt && !refByMember.has(String(m._id))) updates.push({ updateOne: { filter: { _id: m._id }, update: { referredBy: r._id, utmSource: "referral", utmMedium: "link", utmCampaign: null } } });
    }
  }
  await Member.bulkWrite(updates);

  const imp = await Import.create({ fileName: "EtsySoldOrders-demo.csv", rowsTotal: 110, rowsAdded: 110, importedBy: "seed" });
  const sales = [];
  let order = 3412870001;
  for (let i = 0; i < 110; i++) {
    const roll = rnd();
    const r = roll < 0.68 ? pickRef() : null;
    const code = r ? r.code : roll < 0.88 ? s.generalVipCode : "";
    const discount = code ? 6 : 0;
    const { base, amount } = calcCommission(59.99, discount, s);
    const active = r?.status === "active";
    const saleDate = ago(4 + Math.floor(rnd() * 50));
    sales.push({ orderId: String(order++), platform: "etsy", saleDate, couponCode: code, referrerId: r?._id ?? null, quantity: 1, orderValue: 59.99, discount, baseAmount: base, commissionPercent: s.commissionPercent, commissionAmount: active ? amount : 0, commissionStatus: active ? "pending" : "cancelled", flagged: r && !active ? `Referrer ${r.status} — commission $0` : "", importId: imp._id, buyerName: `${pick(FIRST)} ${pick(LAST)[0]}.` });
  }
  await Sale.insertMany(sales);
  const cutoff = new Date(Date.now() - s.holdingDays * 86_400_000);
  await Sale.updateMany({ commissionStatus: "pending", saleDate: { $lte: cutoff } }, { commissionStatus: "approved" });

  // pay the top 3 referrers their approved commission
  const top = await Sale.aggregate([{ $match: { commissionStatus: "approved" } }, { $group: { _id: "$referrerId", n: { $sum: "$commissionAmount" }, ids: { $push: "$_id" } } }, { $sort: { n: -1 } }, { $limit: 3 }]);
  for (const t of top) {
    if (t.n < s.minPayout) continue;
    const p = await Payout.create({ referrerId: t._id, amount: round2(t.n), paidOn: ago(2), method: "PayPal", transactionId: `PP-${Math.floor(rnd() * 1e9)}`, note: "October payout", createdBy: "seed" });
    await Sale.updateMany({ _id: { $in: t.ids } }, { commissionStatus: "paid", payoutId: p._id });
    await PayoutSale.insertMany(t.ids.map((saleId: unknown) => ({ payoutId: p._id, saleId })));
  }

  await Announcement.insertMany([
    { titleEn: "Final chapter in review", titleEs: "Último capítulo en revisión", bodyEn: "<p>The last chapter — <b>Track your progress</b> — is in final review. VIP members will get the launch date first.</p>", bodyEs: "<p>El último capítulo — <b>Siga su progreso</b> — está en revisión final.</p>", pinned: true, sortOrder: 0, status: "published", buttonTextEn: "Join the VIP list", buttonTextEs: "Unirme a la lista VIP", buttonUrl: "#join" },
    { titleEn: "Spanish edition confirmed", titleEs: "Edición en español confirmada", bodyEn: "<p>The manual will launch in <b>English and Spanish</b> on the same day.</p>", bodyEs: "<p>El manual saldrá en <b>inglés y español</b> el mismo día.</p>", sortOrder: 1, status: "published" },
    { titleEn: "Launch week bonus", bodyEn: "<p>Draft — bonus checklist for the first 1,000 buyers.</p>", sortOrder: 2, status: "draft" },
  ]);
  await BuyClick.insertMany(Array.from({ length: 140 }, () => { const r = rnd() < 0.6 ? pickRef() : null; return { referrerId: r?._id ?? null, lang: rnd() < 0.3 ? "es" : "en", codeShown: r?.code ?? s.generalVipCode, clickedAt: ago(Math.floor(rnd() * 40)) }; }));
  const visits = [];
  for (let d = 0; d < 30; d++) for (let v = 0; v < 40 + (30 - d) * 3; v++) visits.push({ visitorHash: `demo-${d}-${v}`, visitedOn: dayKey(new Date(Date.now() - d * 86_400_000)), lang: rnd() < 0.3 ? "es" : "en" });
  await PageVisit.insertMany(visits);
  logger.info({ members: docs.length, referrers: refs.length, sales: sales.length }, "Demo data created");
}

(async () => {
  await connectDB();
  await bootstrap();
  if (process.argv.includes("--demo")) await demo();
  await disconnectDB();
  logger.info("Seed complete");
})().catch(async (e) => { logger.fatal(e); await disconnectDB(); process.exit(1); });
