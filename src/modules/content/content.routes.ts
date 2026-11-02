import { Router } from "express";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { ok } from "../../common/http";
import { validate } from "../../common/validate";
import { imageUpload, UPLOAD_DIR } from "../../common/upload";
import { BadRequest } from "../../common/errors";
import { env } from "../../config/env";
import { audit } from "../activity/activity.service";
import { contentService } from "./content.service";
import { IMAGE_SLOTS, TEXT_KEYS } from "./content.model";

const bi = z.object({ en: z.string().max(20000), es: z.string().max(20000) });
const textsSchema = z.object({ texts: z.partialRecord(z.enum(TEXT_KEYS), bi) });
const faqSchema = z.object({ faq: z.array(z.object({ qEn: z.string().min(1).max(500), qEs: z.string().max(500).default(""), aEn: z.string().min(1).max(3000), aEs: z.string().max(3000).default("") })).max(50) });
const pagesSchema = z.object({ pages: z.object({ privacy: bi, terms: bi, referralTerms: bi }).partial() });

export const contentRouter = Router();

/** A11 Site content */
contentRouter.get("/", async (_req, res) => ok(res, await contentService.get()));

contentRouter.put("/texts", validate(textsSchema), async (req, res) => {
  const cur = await contentService.get();
  const doc = await contentService.set({ texts: { ...cur.texts, ...req.body.texts } });
  await audit(req, "Edited site texts", "site_content", undefined, Object.keys(req.body.texts).join(", "));
  ok(res, doc);
});

/** Add / edit / delete / reorder = send the full ordered list. */
contentRouter.put("/faq", validate(faqSchema), async (req, res) => {
  const doc = await contentService.set({ faq: req.body.faq });
  await audit(req, "Edited FAQ", "site_content", undefined, `${req.body.faq.length} questions`);
  ok(res, doc);
});

contentRouter.put("/pages", validate(pagesSchema), async (req, res) => {
  const patch = Object.fromEntries(Object.entries(req.body.pages).map(([k, v]) => [`pages.${k}`, v]));
  const doc = await contentService.set(patch);
  await audit(req, "Edited policy pages", "site_content", undefined, Object.keys(req.body.pages).join(", "));
  ok(res, doc);
});

contentRouter.post("/images/:slot", imageUpload.single("image"), async (req, res) => {
  const slot = String(req.params.slot);
  if (!(IMAGE_SLOTS as readonly string[]).includes(slot)) throw BadRequest(`Slot must be one of ${IMAGE_SLOTS.join(", ")}`);
  if (!req.file) throw BadRequest("Send the image as multipart field 'image'");
  const url = `${env.API_URL}/uploads/${req.file.filename}`;
  const doc = await contentService.set({ [`images.${slot}`]: url });
  await audit(req, `Changed ${slot} image`, "site_content");
  ok(res, doc);
});

contentRouter.delete("/images/:slot", async (req, res) => {
  const slot = String(req.params.slot);
  if (!(IMAGE_SLOTS as readonly string[]).includes(slot)) throw BadRequest("Unknown slot");
  const cur = await contentService.get();
  const old = cur.images[slot];
  if (old?.includes("/uploads/")) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(old))).catch(() => undefined);
  const doc = await contentService.set({ [`images.${slot}`]: "" });
  await audit(req, `Removed ${slot} image`, "site_content");
  ok(res, doc);
});
