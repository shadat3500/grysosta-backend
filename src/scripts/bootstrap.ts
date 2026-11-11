import { settingsService } from "../modules/settings/settings.service";
import { contentService } from "../modules/content/content.service";
import { emailService } from "../modules/emails/email.service";
import { Admin } from "../modules/auth/admin.model";
import { authService } from "../modules/auth/auth.service";
import { env } from "../config/env";
import { logger } from "../config/logger";

/** Idempotent: default settings, site content, email templates E1–E6 and the first admin. */
export async function bootstrap() {
  await settingsService.get();
  await contentService.get();
  await emailService.ensureTemplates();
  if (await Admin.exists({})) {
    logger.info("Admin already exists - no new admin created. Existing admins can log in.");
  } else if (!env.ADMIN_PASSWORD) {
    logger.warn("No admin exists and ADMIN_PASSWORD is empty in .env - set ADMIN_EMAIL and ADMIN_PASSWORD, then run npm run seed again.");
  } else {
    await Admin.create({ name: env.ADMIN_NAME, email: env.ADMIN_EMAIL, passwordHash: await authService.hash(env.ADMIN_PASSWORD), role: "owner" });
    logger.info({ email: env.ADMIN_EMAIL }, "First admin created");
  }
}
