import type { NextFunction, Request, Response } from "express";
import { z, type ZodType } from "zod";
import { BadRequest } from "./errors";

type Part = "body" | "query" | "params";

/** Validates and replaces req[part] with the parsed (typed, coerced, stripped) value. */
export const validate = (schema: ZodType, part: Part = "body") => (req: Request, _res: Response, next: NextFunction) => {
  const r = schema.safeParse(req[part]);
  if (!r.success) throw BadRequest("Validation failed", z.flattenError(r.error).fieldErrors);
  if (part === "query") Object.defineProperty(req, "query", { value: r.data, writable: true, configurable: true });
  else (req as unknown as Record<Part, unknown>)[part] = r.data;
  next();
};

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
export const idParams = z.object({ id: objectId });
export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().max(40).optional(),
});
export const dateRange = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
export const langEnum = z.enum(["en", "es"]);
export const exportFormat = z.object({ format: z.enum(["csv", "xlsx"]).default("csv") });

export function rangeFilter(from?: string, to?: string) {
  if (!from && !to) return undefined;
  const f: Record<string, Date> = {};
  if (from) f.$gte = new Date(`${from}T00:00:00.000Z`);
  if (to) f.$lte = new Date(`${to}T23:59:59.999Z`);
  return f;
}
