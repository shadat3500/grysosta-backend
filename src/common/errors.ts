export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const BadRequest = (msg = "Bad request", details?: unknown) => new AppError(400, "BAD_REQUEST", msg, details);
export const Unauthorized = (msg = "Authentication required") => new AppError(401, "UNAUTHORIZED", msg);
export const Forbidden = (msg = "Forbidden") => new AppError(403, "FORBIDDEN", msg);
export const NotFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
export const Conflict = (msg: string, details?: unknown) => new AppError(409, "CONFLICT", msg, details);
export const Locked = (msg: string) => new AppError(423, "LOCKED", msg);
export const TooMany = (msg = "Too many requests, please try again later.") => new AppError(429, "RATE_LIMITED", msg);
