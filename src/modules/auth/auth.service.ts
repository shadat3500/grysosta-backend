import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";
import { Types } from "mongoose";
import { Admin } from "./admin.model";
import { Session } from "./session.model";
import { env } from "../../config/env";
import { BadRequest, Locked, Unauthorized } from "../../common/errors";
import { randomToken, sha256 } from "../../common/utils/crypto";

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const IDLE_MS = () => env.SESSION_IDLE_MINUTES * 60_000;

const totp = (secret: string, label = "admin") =>
  new OTPAuth.TOTP({ issuer: "GRYSOSTA Admin", label, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });

export async function createSession(kind: "admin" | "challenge" | "magic" | "referrer", subjectId: Types.ObjectId | string, ttlMs: number, userAgent = "") {
  const token = randomToken(32);
  await Session.create({ tokenHash: sha256(token), kind, subjectId, expiresAt: new Date(Date.now() + ttlMs), userAgent });
  return token;
}

export const authService = {
  hash: (p: string) => bcrypt.hash(p, 12),

  /** SRS A1: email + password, lock 15 min after 5 wrong passwords, optional 2-step. */
  async login(email: string, password: string, ua: string) {
    const admin = await Admin.findOne({ email }).select("+passwordHash");
    if (!admin) {
      await bcrypt.compare(password, "$2a$12$CwTycUXWue0Thq9StjUM0uJ8.qhH0F6JbNhrVn6Cq5xY8s7o8l3W2"); // timing
      throw Unauthorized("Wrong email or password");
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) throw Locked(`Too many wrong passwords. Try again after ${admin.lockedUntil.toISOString()}`);
    const okPw = await bcrypt.compare(password, admin.passwordHash);
    if (!okPw) {
      const recent = (admin.failedLogins as unknown as Date[]).map((d) => new Date(d)).filter((d) => d.getTime() > Date.now() - LOCK_MINUTES * 60_000);
      recent.push(new Date());
      if (recent.length >= LOCK_AFTER) {
        admin.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
        admin.set("failedLogins", []);
        await admin.save();
        throw Locked(`Too many wrong passwords. Account locked for ${LOCK_MINUTES} minutes`);
      }
      admin.set("failedLogins", recent);
      await admin.save();
      throw Unauthorized(`Wrong email or password. ${LOCK_AFTER - recent.length} attempt(s) left before a ${LOCK_MINUTES}-minute lock`);
    }
    admin.set("failedLogins", []);
    admin.lockedUntil = null;
    if (admin.twoFactorEnabled) {
      await admin.save();
      const challengeToken = await createSession("challenge", admin._id, 5 * 60_000, ua);
      return { twoFactorRequired: true as const, challengeToken };
    }
    admin.lastLoginAt = new Date();
    await admin.save();
    const token = await createSession("admin", admin._id, env.SESSION_MAX_HOURS * 3_600_000, ua);
    return { twoFactorRequired: false as const, token, admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role } };
  },

  async verify2fa(challengeToken: string, code: string, ua: string) {
    const s = await Session.findOne({ tokenHash: sha256(challengeToken), kind: "challenge", expiresAt: { $gt: new Date() } });
    if (!s) throw Unauthorized("Login challenge expired. Please sign in again");
    const admin = await Admin.findById(s.subjectId).select("+twoFactorSecret");
    if (!admin?.twoFactorSecret) throw Unauthorized();
    if (totp(admin.twoFactorSecret).validate({ token: code, window: 1 }) === null) throw Unauthorized("Invalid code");
    await s.deleteOne();
    admin.lastLoginAt = new Date();
    await admin.save();
    const token = await createSession("admin", admin._id, env.SESSION_MAX_HOURS * 3_600_000, ua);
    return { token, admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role } };
  },

  /** Returns the admin for a valid session; enforces the 2-hour idle timeout. */
  async resolveSession(token: string) {
    const s = await Session.findOne({ tokenHash: sha256(token), kind: "admin" });
    if (!s || s.expiresAt < new Date()) throw Unauthorized("Session expired. Please log in again");
    if (Date.now() - s.lastActiveAt.getTime() > IDLE_MS()) {
      await s.deleteOne();
      throw Unauthorized("Session expired after inactivity. Please log in again");
    }
    if (Date.now() - s.lastActiveAt.getTime() > 60_000) await Session.updateOne({ _id: s._id }, { lastActiveAt: new Date() });
    const admin = await Admin.findById(s.subjectId).lean();
    if (!admin) throw Unauthorized();
    return { admin, sessionId: String(s._id) };
  },

  logout: (token: string) => Session.deleteOne({ tokenHash: sha256(token) }),

  /** Always resolves (no account enumeration). Returns the raw token so the caller can email it. */
  async forgotPassword(email: string) {
    const admin = await Admin.findOne({ email });
    if (!admin) return null;
    const token = randomToken(32);
    await Admin.updateOne({ _id: admin._id }, { resetTokenHash: sha256(token), resetTokenExpires: new Date(Date.now() + 60 * 60_000) });
    return { admin, token };
  },

  async resetPassword(token: string, password: string) {
    const admin = await Admin.findOne({ resetTokenHash: sha256(token), resetTokenExpires: { $gt: new Date() } });
    if (!admin) throw BadRequest("Reset link is invalid or has expired");
    await Admin.updateOne({ _id: admin._id }, { passwordHash: await this.hash(password), resetTokenHash: null, resetTokenExpires: null, failedLogins: [], lockedUntil: null });
    await Session.deleteMany({ subjectId: admin._id, kind: "admin" });
    return admin;
  },

  async changePassword(adminId: Types.ObjectId, current: string, next: string, keepSessionId?: string) {
    const admin = await Admin.findById(adminId).select("+passwordHash");
    if (!admin || !(await bcrypt.compare(current, admin.passwordHash))) throw BadRequest("Current password is wrong");
    admin.passwordHash = await this.hash(next);
    await admin.save();
    await Session.deleteMany({ subjectId: adminId, kind: "admin", _id: { $ne: keepSessionId } });
  },

  async setup2fa(adminId: Types.ObjectId) {
    const admin = await Admin.findById(adminId);
    if (!admin) throw Unauthorized();
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await Admin.updateOne({ _id: adminId }, { pendingTwoFactorSecret: secret });
    return { secret, otpauthUrl: totp(secret, admin.email).toString() };
  },

  async enable2fa(adminId: Types.ObjectId, code: string) {
    const admin = await Admin.findById(adminId).select("+pendingTwoFactorSecret");
    if (!admin?.pendingTwoFactorSecret) throw BadRequest("Start 2-step setup first");
    if (totp(admin.pendingTwoFactorSecret).validate({ token: code, window: 1 }) === null) throw BadRequest("Invalid code");
    await Admin.updateOne({ _id: adminId }, { twoFactorEnabled: true, twoFactorSecret: admin.pendingTwoFactorSecret, pendingTwoFactorSecret: null });
  },

  async disable2fa(adminId: Types.ObjectId, code: string) {
    const admin = await Admin.findById(adminId).select("+twoFactorSecret");
    if (!admin?.twoFactorEnabled || !admin.twoFactorSecret) throw BadRequest("2-step login is not enabled");
    if (totp(admin.twoFactorSecret).validate({ token: code, window: 1 }) === null) throw BadRequest("Invalid code");
    await Admin.updateOne({ _id: adminId }, { twoFactorEnabled: false, twoFactorSecret: null });
  },
};

export { totp };
