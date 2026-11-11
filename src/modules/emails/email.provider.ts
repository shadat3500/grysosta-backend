import nodemailer, { type Transporter } from "nodemailer";
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

/**
 * SMTP (Gmail by default: smtp.gmail.com, port 465, username + Google "app password").
 * Gmail sends from the account it logs in with, so EMAIL_FROM_ADDRESS should be the same address.
 */
let smtpTransport: Transporter | null = null;
function makeTransport(): Transporter {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD.replace(/\s+/g, "") },
  });
}
const smtp: MailProvider = {
  async send(m) {
    smtpTransport ??= makeTransport();
    const info = await smtpTransport.sendMail({
      from: { name: env.EMAIL_FROM_NAME, address: env.EMAIL_FROM_ADDRESS },
      to: m.name ? { name: m.name, address: m.to } : m.to,
      replyTo: m.replyTo,
      subject: m.subject,
      html: m.html,
      text: m.text,
      headers: m.headers,
    });
    return { id: info.messageId ?? "" };
  },
};

const provider = env.EMAIL_PROVIDER ?? (env.SMTP_USERNAME ? "smtp" : env.BREVO_API_KEY ? "brevo" : "console");
export const mailProvider: MailProvider = provider === "smtp" ? smtp : provider === "brevo" ? brevo : consoleProvider;

/** Startup check: connects to the SMTP server and logs whether it connected. No email is sent. */
export async function checkSmtpConnection() {
  if (provider !== "smtp") return;
  try {
    smtpTransport ??= makeTransport();
    await smtpTransport.verify();
    logger.info({ host: env.SMTP_HOST, user: env.SMTP_USERNAME }, "SMTP server connected");
  } catch (e) {
    logger.error({ host: env.SMTP_HOST, user: env.SMTP_USERNAME, err: (e as Error).message }, "SMTP server connection failed");
  }
}
