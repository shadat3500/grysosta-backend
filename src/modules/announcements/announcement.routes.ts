import { Router } from "express";
import { z } from "zod";
import { ok, created } from "../../common/http";
import { idParams, objectId, validate } from "../../common/validate";
import { BadRequest, NotFound } from "../../common/errors";
import { imageUpload } from "../../common/upload";
import { env } from "../../config/env";
import { audit } from "../activity/activity.service";
import { Announcement, effectiveStatus } from "./announcement.model";
import { emailService, type Audience } from "../emails/email.service";
import { sanitizeHtml } from "../../common/utils/sanitize";

const dt = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/), z.null()]).optional();
const base = z.object({
  titleEn: z.string().trim().min(1).max(200),
  titleEs: z.string().trim().max(200).default(""),
  bodyEn: z.string().max(20000).default(""),
  bodyEs: z.string().max(20000).default(""),
  imageUrl: z.string().max(1000).default(""),
  buttonTextEn: z.string().max(80).default(""),
  buttonTextEs: z.string().max(80).default(""),
  buttonUrl: z.string().max(1000).default(""),
  pinned: z.boolean().default(false),
  status: z.enum(["draft", "published", "scheduled"]).default("draft"),
  startsAt: dt,
  endsAt: dt,
});

function normalize(b: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...b };
  for (const k of ["bodyEn", "bodyEs"]) if (typeof out[k] === "string") out[k] = sanitizeHtml(out[k] as string);
  for (const k of ["startsAt", "endsAt"]) if (k in out) out[k] = out[k] ? new Date(out[k] as string) : null;
  if (out.startsAt && out.endsAt && (out.endsAt as Date) < (out.startsAt as Date)) throw BadRequest("End date must be after the start date");
  if (out.status === "published" && out.startsAt && (out.startsAt as Date) > new Date()) out.status = "scheduled";
  return out;
}

export const announcementRouter = Router();

/** A4 list: title, EN ✔ / ES ✔, status (Draft / Published / Scheduled / Expired), pinned, date. */
announcementRouter.get("/", async (_req, res) => {
  const list = await Announcement.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
  ok(res, list.map((a) => ({ ...a, effectiveStatus: effectiveStatus(a), hasEn: !!(a.titleEn && a.bodyEn), hasEs: !!(a.titleEs && a.bodyEs) })));
});

announcementRouter.get("/:id", validate(idParams, "params"), async (req, res) => {
  const a = await Announcement.findById(req.params.id).lean();
  if (!a) throw NotFound("Announcement");
  ok(res, { ...a, effectiveStatus: effectiveStatus(a) });
});

announcementRouter.post("/", validate(base), async (req, res) => {
  const last = await Announcement.findOne().sort({ sortOrder: -1 }).lean();
  const a = await Announcement.create({ ...normalize(req.body), sortOrder: (last?.sortOrder ?? -1) + 1 });
  await audit(req, "Created announcement", "announcements", String(a._id), a.titleEn);
  created(res, a);
});

announcementRouter.patch("/reorder", validate(z.object({ ids: z.array(objectId).min(1).max(500) })), async (req, res) => {
  await Announcement.bulkWrite(req.body.ids.map((id: string, i: number) => ({ updateOne: { filter: { _id: id }, update: { sortOrder: i } } })));
  await audit(req, "Reordered announcements", "announcements");
  ok(res, { reordered: req.body.ids.length });
});

announcementRouter.patch("/:id", validate(idParams, "params"), validate(base.partial()), async (req, res) => {
  const a = await Announcement.findByIdAndUpdate(req.params.id, { $set: normalize(req.body) }, { returnDocument: "after", runValidators: true }).lean();
  if (!a) throw NotFound("Announcement");
  await audit(req, "Edited announcement", "announcements", String(a._id), a.titleEn);
  ok(res, a);
});

announcementRouter.delete("/:id", validate(idParams, "params"), async (req, res) => {
  const a = await Announcement.findByIdAndDelete(req.params.id).lean();
  if (!a) throw NotFound("Announcement");
  await audit(req, "Deleted announcement", "announcements", String(a._id), a.titleEn);
  ok(res, { deleted: true });
});

/** Optional image upload → returns a URL to put in imageUrl. */
announcementRouter.post("/upload-image", imageUpload.single("image"), async (req, res) => {
  if (!req.file) throw BadRequest("Send the image as multipart field 'image'");
  ok(res, { url: `${env.API_URL}/uploads/${req.file.filename}` });
});

/** "Email this announcement" → All / English / Spanish / Referrers only → E3 */
announcementRouter.post("/:id/email", validate(idParams, "params"), validate(z.object({ audience: z.enum(["all", "en", "es", "referrers"]).default("all") })), async (req, res) => {
  const a = await Announcement.findById(req.params.id).lean();
  if (!a) throw NotFound("Announcement");
  const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // Per-language vars are resolved by the worker from the member language: we pass both and pick in the template.
  const log = await emailService.bulkSend("E3", req.body.audience as Audience, { announcement_title: a.titleEn, announcement_body: strip(a.bodyEn), announcement_title_es: a.titleEs || a.titleEn, announcement_body_es: strip(a.bodyEs || a.bodyEn) }, req.admin?.name ?? "admin");
  await audit(req, "Emailed announcement", "announcements", String(a._id), `${log.total} recipients`);
  ok(res, log, undefined, 202);
});
