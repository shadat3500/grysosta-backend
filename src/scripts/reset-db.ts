/**
 * npm run db:reset  → DROPS the whole database (all members, sales, admins, settings), then runs the seed.
 * Local development only: refuses to run when NODE_ENV=production.
 */
import { connectDB, disconnectDB } from "../config/db";
import { env } from "../config/env";
import { logger } from "../config/logger";
import mongoose from "mongoose";

(async () => {
  if (env.NODE_ENV === "production") throw new Error("db:reset is disabled when NODE_ENV=production");
  await connectDB();
  const name = mongoose.connection.name;
  await mongoose.connection.dropDatabase();
  logger.warn({ db: name }, "Database dropped");
  await disconnectDB();
})().catch(async (e) => { logger.fatal(e); await disconnectDB(); process.exit(1); });
