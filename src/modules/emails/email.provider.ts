import { env } from "../../config/env";
import { logger } from "../../config/logger";

export interface OutgoingMail {
  to: string;
  name?: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface MailProvider { send(m: OutgoingMail): Promise<{ id: string }> }

/** Brevo transactional API (SRS 3.1). */
const brevo: MailProvider = {
  async send(m) {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: env.EMAIL_FROM_NAME, email: env.EMAIL_FROM_ADDRESS },
        to: [{ email: m.to, name: m.name || undefined }],
        replyTo: m.replyTo ? { email: m.replyTo } : undefined,
        subject: m.subject,
        htmlContent: m.html,
        textContent: m.text,
        headers: m.headers,
      }),
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as { messageId?: string };
    return { id: j.messageId ?? "" };
  },
};

/** Development / test: emails are logged and kept in memory (see `sentMail`). */
export const sentMail: OutgoingMail[] = [];
const consoleProvider: MailProvider = {
  async send(m) {
    sentMail.push(m);
    if (sentMail.length > 200) sentMail.shift();
    logger.info({ to: m.to, subject: m.subject }, "📧 email (console provider)");
    return { id: `console-${Date.now()}` };
  },
};

export const mailProvider: MailProvider = env.BREVO_API_KEY ? brevo : consoleProvider;
