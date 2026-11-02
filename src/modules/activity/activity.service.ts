import type { Request } from "express";
import { Activity } from "./activity.model";
import { logger } from "../../config/logger";

/** SRS A1: every admin action saved (who, what, when). Never throws. */
export async function audit(req: Request | null, action: string, entity: string, entityId?: string, details?: string) {
  try {
    await Activity.create({
      adminId: req?.admin?._id ?? null,
      adminName: req?.admin?.name ?? "system",
      action, entity, entityId: entityId ?? null, details: details ?? "",
      ip: req ? String(req.ip ?? "") : "",
    });
  } catch (e) {
    logger.error(e, "audit failed");
  }
}
