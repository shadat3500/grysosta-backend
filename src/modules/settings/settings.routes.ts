import { Router } from "express";
import { ok } from "../../common/http";
import { validate } from "../../common/validate";
import { audit } from "../activity/activity.service";
import { settingsService } from "./settings.service";
import { featuresSchema, siteModeSchema, updateSettingsSchema } from "./settings.schema";
import { Referrer } from "../referrers/referrer.model";
import { Conflict } from "../../common/errors";

export const settingsRouter = Router();

/** A12 */
settingsRouter.get("/", async (_req, res) => ok(res, await settingsService.get()));

/** Client switches: turn Prepay and the referral program on or off (each change is logged). */
settingsRouter.patch("/features", validate(featuresSchema), async (req, res) => {
  const before = await settingsService.get();
  const doc = await settingsService.update(req.body);
  const labels: Record<string, string> = { prepayEnabled: "Prepay", referralEnabled: "Referral program" };
  for (const k of Object.keys(labels) as (keyof typeof labels)[]) {
    if (k in req.body && before[k as "prepayEnabled"] !== req.body[k]) await audit(req, `${labels[k]} turned ${req.body[k] ? "ON" : "OFF"}`, "settings", undefined, labels[k]);
  }
  ok(res, doc);
});

settingsRouter.patch("/", validate(updateSettingsSchema), async (req, res) => {
  const doc = await settingsService.update(req.body);
  await audit(req, "Updated settings", "settings", undefined, Object.keys(req.body).join(", "));
  ok(res, doc, Object.prototype.hasOwnProperty.call(req.body, "commissionPercent") ? { note: "New commission % applies only to sales imported from now on." } : undefined);
});

/** A3 Site mode & book links */
settingsRouter.patch("/site-mode", validate(siteModeSchema), async (req, res) => {
  if (req.body.generalVipCode && (await Referrer.exists({ code: String(req.body.generalVipCode).toUpperCase() }))) throw Conflict("This code is already used by a referrer");
  const before = await settingsService.get();
  const doc = await settingsService.updateSiteMode(req.body);
  const action = req.body.siteMode && req.body.siteMode !== before.siteMode ? (req.body.siteMode === "launch" ? "Switched to Launch mode" : "Switched to Pre-launch mode") : "Updated site mode & book links";
  await audit(req, action, "settings", undefined, Object.keys(req.body).join(", "));
  ok(res, doc);
});
