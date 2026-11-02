import type { Response } from "express";

export const ok = <T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

export const created = <T>(res: Response, data: T) => ok(res, data, undefined, 201);

export interface PageQuery { page: number; limit: number; sort?: string }

export const pageMeta = (total: number, q: PageQuery) => ({ total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)) });

/** "-createdAt" → { createdAt: -1 }; only whitelisted fields. */
export function sortSpec(sort: string | undefined, allowed: string[], fallback: Record<string, 1 | -1>) {
  if (!sort) return fallback;
  const desc = sort.startsWith("-");
  const field = sort.replace(/^-/, "");
  return allowed.includes(field) ? ({ [field]: desc ? -1 : 1 } as Record<string, 1 | -1>) : fallback;
}
