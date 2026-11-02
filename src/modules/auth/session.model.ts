import { Schema, Types, model } from "mongoose";

/**
 * Opaque, hashed tokens (raw token never stored).
 *  admin     – admin panel session (idle timeout + absolute expiry)
 *  challenge – password OK, waiting for 2-step code (5 min)
 *  magic     – referrer magic link (30 min, single use)
 *  referrer  – referrer self-check session after a magic link (24 h)
 */
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["admin", "challenge", "magic", "referrer"], required: true },
    subjectId: { type: Types.ObjectId, required: true, index: true },
    lastActiveAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model("Session", sessionSchema, "sessions");
