import type { Request } from "express";
import { Activity } from "./activity.model";
import { logger } from "../../config/logger";
import { publish } from "../../common/realtime";

/** SRS A1: every admin action saved (who, what, when). Never throws. Also pushed live to open admin panels. */
export async function audit(req: Request | null, action: string, entity: string, entityId?: string, details?: string) {
  try {
    const adminName = req?.admin?.name ?? "system";
    await Activity.create({
      adminId: req?.admin?._id ?? null,
      adminName,
      action, entity, entityId: entityId ?? null, details: details ?? "",
      ip: req ? String(req.ip ?? "") : "",
    });
    publish("activity", { action, entity, entityId: entityId ?? null, details: details ?? "", adminName });
  } catch (e) {
    logger.error(e, "audit failed");
  }
}
