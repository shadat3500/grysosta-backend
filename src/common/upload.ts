import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { BadRequest } from "./errors";
import { randomToken } from "./utils/crypto";

export const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** SRS 11.2: CSV max 10 MB, .csv only, parsed on the server (kept in memory, never written to disk). */
export const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".csv")) return cb(BadRequest("Only .csv files are allowed"));
    cb(null, true);
  },
});

/** Images (announcements, site images). Local disk driver — swap for S3 / Supabase Storage in production. */
export const imageUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomToken(6)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(webp|jpeg|png|gif|avif)$/.test(file.mimetype)) return cb(BadRequest("Only WebP, JPG, PNG, GIF or AVIF images are allowed"));
    cb(null, true);
  },
});
