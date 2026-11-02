import { Router } from "express";
import { Types } from "mongoose";
import { ok, pageMeta, sortSpec } from "../../common/http";
import { idParams, validate } from "../../common/validate";
import { BadRequest, NotFound } from "../../common/errors";
import { sendExport } from "../../common/utils/export";
import { env } from "../../config/env";
import { audit } from "../activity/activity.service";
import { Member } from "./member.model";
import { memberService } from "./member.service";
import { bulkSchema, listMembersSchema, updateMemberSchema } from "./member.schema";
import { Referrer } from "../referrers/referrer.model";
import { referralLink, referrerService } from "../referrers/referrer.service";
import { emailService } from "../emails/email.service";

export const memberRouter = Router();

/** A5 — table, search, filters, pagination 50, CSV/Excel export (?format=csv|xlsx) */
memberRouter.get("/", validate(listMembersSchema, "query"), async (req, res) => {
  const q = req.query as unknown as ReturnType<typeof listMembersSchema.parse>;
  const filter = memberService.buildFilter(q);
  if (q.format !== "json") return sendExport(res, await memberService.exportRows(filter), "vip-members", q.format);
  const sort = sortSpec(q.sort, ["createdAt", "firstName", "lastName", "email", "language", "status", "isReferrer", "utmSource"], { createdAt: -1 });
  const [items, total] = await Promise.all([
    Member.find(filter).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).populate("referredBy", "code").lean(),
    Member.countDocuments(filter),
  ]);
  ok(res, items.map(({ unsubscribeToken: _t, visitorHash: _v, ...m }) => m), pageMeta(total, q));
});

memberRouter.post("/bulk", validate(bulkSchema), async (req, res) => {
  const { action, ids, format } = req.body;
  if (action === "export") return sendExport(res, await memberService.exportRows({ _id: { $in: ids.map((x: string) => new Types.ObjectId(x)) } }), "vip-members-selected", format);
  const n = action === "delete" ? await memberService.deleteMany(ids) : await memberService.unsubscribeMany(ids);
  await audit(req, action === "delete" ? "Deleted members (GDPR)" : "Unsubscribed members", "members", undefined, `${n} member(s)`);
  ok(res, { affected: n });
});

memberRouter.get("/:id", validate(idParams, "params"), async (req, res) => {
  const m = await Member.findById(req.params.id).populate("referredBy", "code status").lean();
  if (!m) throw NotFound("Member");
  const own = await Referrer.findOne({ memberId: m._id }, { code: 1, status: 1 }).lean();
  ok(res, { ...m, ownReferrer: own ? { id: own._id, code: own.code, status: own.status, link: referralLink(own.code) } : null, unsubscribeLink: `${env.SITE_URL}/${m.language}/unsubscribe?token=${m.unsubscribeToken}` });
});

memberRouter.patch("/:id", validate(idParams, "params"), validate(updateMemberSchema), async (req, res) => {
  const m = await Member.findByIdAndUpdate(req.params.id, { $set: req.body }, { returnDocument: "after", runValidators: true }).lean();
  if (!m) throw NotFound("Member");
  await audit(req, "Edited member", "members", String(m._id), Object.keys(req.body).join(", "));
  ok(res, m);
});

memberRouter.delete("/:id", validate(idParams, "params"), async (req, res) => {
  const n = await memberService.deleteMany([String(req.params.id)]);
  if (!n) throw NotFound("Member");
  await audit(req, "Deleted member (GDPR)", "members", String(req.params.id));
  ok(res, { deleted: true });
});

memberRouter.post("/:id/make-referrer", validate(idParams, "params"), async (req, res) => {
  const m = await Member.findById(req.params.id).lean();
  if (!m) throw NotFound("Member");
  if (m.isReferrer) throw BadRequest("Member is already a referrer");
  const r = await referrerService.createForMember(m._id, m.firstName);
  await emailService.enqueueForMember("E2", { ...m, isReferrer: true } as never);
  await audit(req, "Made member a referrer", "referrers", String(r._id), r.code);
  ok(res, { id: r._id, code: r.code, link: referralLink(r.code) });
});

memberRouter.post("/:id/unsubscribe", validate(idParams, "params"), async (req, res) => {
  const n = await memberService.unsubscribeMany([String(req.params.id)]);
  await audit(req, "Unsubscribed member", "members", String(req.params.id));
  ok(res, { unsubscribed: n > 0 });
});
