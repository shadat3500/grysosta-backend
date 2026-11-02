import { Router, type Response } from "express";
import { ok } from "../../common/http";
import { validate } from "../../common/validate";
import { loginLimiter } from "../../common/rateLimit";
import { env } from "../../config/env";
import { audit } from "../activity/activity.service";
import { mailProvider } from "../emails/email.provider";
import { authService } from "./auth.service";
import { ADMIN_COOKIE, readToken, requireAdmin } from "./auth.middleware";
import { changePasswordSchema, codeSchema, forgotSchema, loginSchema, resetSchema, verify2faSchema } from "./auth.schema";
import { Admin } from "./admin.model";

export const authRouter = Router();

const setCookie = (res: Response, token: string) =>
  res.cookie(ADMIN_COOKIE, token, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SECURE ? "none" : "lax", maxAge: env.SESSION_MAX_HOURS * 3_600_000, path: "/" });

authRouter.post("/login", loginLimiter, validate(loginSchema), async (req, res) => {
  const r = await authService.login(req.body.email, req.body.password, String(req.headers["user-agent"] ?? ""));
  if (r.twoFactorRequired) return ok(res, { twoFactorRequired: true, challengeToken: r.challengeToken });
  setCookie(res, r.token);
  await audit({ ...req, admin: { _id: r.admin.id, name: r.admin.name } } as never, "Logged in", "auth");
  ok(res, { twoFactorRequired: false, token: r.token, admin: r.admin, idleTimeoutMinutes: env.SESSION_IDLE_MINUTES });
});

authRouter.post("/2fa/verify", loginLimiter, validate(verify2faSchema), async (req, res) => {
  const r = await authService.verify2fa(req.body.challengeToken, req.body.code, String(req.headers["user-agent"] ?? ""));
  setCookie(res, r.token);
  await audit({ ...req, admin: { _id: r.admin.id, name: r.admin.name } } as never, "Logged in (2-step)", "auth");
  ok(res, { token: r.token, admin: r.admin, idleTimeoutMinutes: env.SESSION_IDLE_MINUTES });
});

authRouter.post("/forgot-password", loginLimiter, validate(forgotSchema), async (req, res) => {
  const r = await authService.forgotPassword(req.body.email);
  if (r) {
    const url = `${env.SITE_URL}/admin/reset-password?token=${r.token}`;
    await mailProvider.send({
      to: r.admin.email, subject: "Reset your GRYSOSTA admin password",
      html: `<p>Hi ${r.admin.name},</p><p>Click to reset your password (valid for 1 hour):</p><p><a href="${url}">${url}</a></p><p>If you didn't request this, ignore this email.</p>`,
      text: `Reset your password (valid 1 hour): ${url}`,
    });
  }
  ok(res, { message: "If this is an admin account, a reset link has been sent." });
});

authRouter.post("/reset-password", loginLimiter, validate(resetSchema), async (req, res) => {
  const admin = await authService.resetPassword(req.body.token, req.body.password);
  await audit({ ...req, admin: { _id: admin._id, name: admin.name } } as never, "Reset password", "auth");
  ok(res, { message: "Password updated. Please log in." });
});

/* ---- authenticated ---- */
authRouter.use(requireAdmin);

authRouter.get("/me", async (req, res) => {
  const a = req.admin!;
  ok(res, { id: a._id, name: a.name, email: a.email, role: a.role, twoFactorEnabled: a.twoFactorEnabled, lastLoginAt: a.lastLoginAt, idleTimeoutMinutes: env.SESSION_IDLE_MINUTES });
});

authRouter.post("/logout", async (req, res) => {
  const t = readToken(req, ADMIN_COOKIE);
  if (t) await authService.logout(t);
  await audit(req, "Logged out", "auth");
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
  ok(res, { message: "Logged out" });
});

authRouter.post("/change-password", validate(changePasswordSchema), async (req, res) => {
  await authService.changePassword(req.admin!._id, req.body.currentPassword, req.body.newPassword, req.sessionId);
  await audit(req, "Changed password", "auth");
  ok(res, { message: "Password changed. Other sessions were signed out." });
});

/** Optional 2-step login (authenticator app). */
authRouter.post("/2fa/setup", async (req, res) => ok(res, await authService.setup2fa(req.admin!._id)));
authRouter.post("/2fa/enable", validate(codeSchema), async (req, res) => {
  await authService.enable2fa(req.admin!._id, req.body.code);
  await audit(req, "Enabled 2-step login", "auth");
  ok(res, { twoFactorEnabled: true });
});
authRouter.post("/2fa/disable", validate(codeSchema), async (req, res) => {
  await authService.disable2fa(req.admin!._id, req.body.code);
  await audit(req, "Disabled 2-step login", "auth");
  ok(res, { twoFactorEnabled: false });
});

void Admin;
