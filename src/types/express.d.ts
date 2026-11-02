import type { AdminDoc } from "../modules/auth/admin.model";

declare global {
  namespace Express {
    interface Request {
      admin?: AdminDoc & { _id: import("mongoose").Types.ObjectId };
      sessionId?: string;
      referrerId?: string;
    }
  }
}

export {};
