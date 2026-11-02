import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "./logger";

export async function connectDB(uri = env.MONGODB_URI) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 10000 });
  logger.info({ db: mongoose.connection.name }, "MongoDB connected");
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes().catch((e) => logger.warn(e, `index sync ${m.modelName}`))));
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
