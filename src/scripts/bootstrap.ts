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
  if (!(await Admin.exists({})) && env.ADMIN_PASSWORD) {
    await Admin.create({ name: env.ADMIN_NAME, email: env.ADMIN_EMAIL, passwordHash: await authService.hash(env.ADMIN_PASSWORD), role: "owner" });
    logger.info({ email: env.ADMIN_EMAIL }, "First admin created");
  }
}
