import { createApp } from "./app";
import { connectDB, disconnectDB } from "./config/db";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { startScheduler } from "./modules/jobs/scheduler";
import { bootstrap } from "./scripts/bootstrap";
import { checkSmtpConnection } from "./modules/emails/email.provider";

async function main() {
  const app = createApp(); // registers all models before index sync
  await connectDB();
  await bootstrap();
  await checkSmtpConnection();
  const stopJobs = startScheduler();
  const server = app.listen(env.PORT, () => logger.info(`🚀 GRYSOSTA API on http://localhost:${env.PORT}${env.API_PREFIX}`));

  const shutdown = (sig: string) => {
    logger.info(`${sig} received — shutting down`);
    stopJobs();
    server.close(async () => { await disconnectDB(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => logger.error(e, "unhandledRejection"));
}

main().catch((e) => { logger.fatal(e, "failed to start"); process.exit(1); });
