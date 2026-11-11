import { Router } from "express";
import { z } from "zod";
import { ok } from "../../common/http";
import { validate } from "../../common/validate";
import { Locked } from "../../common/errors";
import { audit } from "../activity/activity.service";
import { Member, TIER_LABEL, TIER_RANK, tierQuery, type MemberDoc, type Tier } from "../members/member.model";
import { emailService } from "../emails/email.service";
import { settingsService } from "../settings/settings.service";
import { InvitationBatch } from "./invitation.model";
import { pageMeta } from "../../common/http";
import { pagination, validate as validateQuery } from "../../common/validate";

/** Only the groups that have not paid yet can be invited (Prepay members have already paid). */
const INVITE_GROUPS = ["reserve", "vip"] as const;
type InviteGroup = (typeof INVITE_GROUPS)[number];

const sendSchema = z.object({
  groups: z.array(z.enum(INVITE_GROUPS)).min(1).max(2),
  batchSize: z.number().int().min(1).max(1000).optional(),
});

/** Not yet invited, subscribed, unpaid — the pool a batch is drawn from. */
const waitingFilter = (t: Tier): Record<string, unknown> => ({ tier: tierQuery(t), status: "subscribed", prepaidAt: null, invitedAt: null });

/** Next batch in priority order (Reserve first, then VIP), oldest sign-up first, never more than `limit`. */
async function nextBatch(groups: InviteGroup[], limit: number) {
  const picked: (MemberDoc & { tier: InviteGroup })[] = [];
  for (const t of [...groups].sort((a, b) => TIER_RANK[a] - TIER_RANK[b])) {
    const room = limit - picked.length;
    if (room <= 0) break;
    const rows = await Member.find(waitingFilter(t)).sort({ createdAt: 1 }).limit(room).lean();
    picked.push(...(rows as unknown as MemberDoc[]).map((m) => ({ ...m, tier: t })));
  }
  return picked;
}

export const invitationRouter = Router();

/** Batch control: send purchase invitations to the groups picked, at most `batchSize` customers per send. */
invitationRouter.post("/send", validate(sendSchema), async (req, res) => {
  const s = await settingsService.get();
  if (!s.prepayEnabled) throw Locked("Turn Prepay on before sending purchase invitations.");
  const groups = [...new Set(req.body.groups as InviteGroup[])];
  const limit = (req.body.batchSize as number | undefined) ?? s.inviteBatchSize;
  const batch = await nextBatch(groups, limit);
  const byGroup: Record<InviteGroup, number> = { reserve: 0, vip: 0 };
  for (const m of batch) {
    await emailService.enqueueForMember("E7", m);
    byGroup[m.tier]++;
  }
  if (batch.length) await Member.updateMany({ _id: { $in: batch.map((m) => m._id) } }, { invitedAt: new Date() });
  let remaining = 0;
  for (const t of groups) remaining += await Member.countDocuments(waitingFilter(t));
  await InvitationBatch.create({ groups, batchSize: limit, invited: batch.length, byGroup, remaining, createdBy: req.admin?.name ?? "admin" });
  await audit(req, "Sent purchase invitations", "invitations", undefined, `${batch.length} invited (${groups.join(", ")}), batch limit ${limit}`);
  ok(res, { invited: batch.length, byGroup, batchSize: limit, remaining });
});

/** Per group: registrations, already invited, still waiting. */
invitationRouter.get("/summary", async (_req, res) => {
  const s = await settingsService.get();
  const groups: Record<string, { label: string; total: number; invited: number; waiting: number }> = {};
  for (const t of INVITE_GROUPS) {
    const base: Record<string, unknown> = { tier: tierQuery(t), prepaidAt: null };
    const [total, invited, waiting] = await Promise.all([
      Member.countDocuments(base),
      Member.countDocuments({ ...base, invitedAt: { $ne: null } }),
      Member.countDocuments({ ...base, status: "subscribed", invitedAt: null }),
    ]);
    groups[t] = { label: TIER_LABEL[t], total, invited, waiting };
  }
  ok(res, { prepayEnabled: s.prepayEnabled, inviteBatchSize: s.inviteBatchSize, groups });
});

/** History of sent batches, newest first. */
invitationRouter.get("/history", validateQuery(pagination, "query"), async (req, res) => {
  const q = req.query as unknown as { page: number; limit: number };
  const [items, total] = await Promise.all([
    InvitationBatch.find().sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    InvitationBatch.countDocuments(),
  ]);
  ok(res, items.map((b) => ({ id: String(b._id), at: b.createdAt, groups: b.groups, batchSize: b.batchSize, invited: b.invited, byGroup: b.byGroup, remaining: b.remaining })), pageMeta(total, q));
});
