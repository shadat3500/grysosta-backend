import type { NextFunction, Request, Response } from "express";
import { Unauthorized } from "../../common/errors";
import { authService } from "./auth.service";
import { Session } from "./session.model";
import { sha256 } from "../../common/utils/crypto";

export const ADMIN_COOKIE = "gsta_admin";
export const REFERRER_COOKIE = "gsta_referrer";

export function readToken(req: Request, cookie: string) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return (req.cookies?.[cookie] as string | undefined) || null;
}

/** All admin API routes check the admin session on the server (SRS 11.2). */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req, ADMIN_COOKIE);
  if (!token) throw Unauthorized();
  const { admin, sessionId } = await authService.resolveSession(token);
  req.admin = admin as Request["admin"];
  req.sessionId = sessionId;
  next();
}

export async function requireReferrer(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req, REFERRER_COOKIE);
  if (!token) throw Unauthorized();
  const s = await Session.findOne({ tokenHash: sha256(token), kind: "referrer", expiresAt: { $gt: new Date() } }).lean();
  if (!s) throw Unauthorized("Your link has expired. Please request a new one");
  req.referrerId = String(s.subjectId);
  next();
}
