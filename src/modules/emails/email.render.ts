import { env } from "../../config/env";

export type Vars = Record<string, string | number>;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const fill = (tpl: string, vars: Vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

function buttonHref(label: string, vars: Vars) {
  const link = String(vars.referral_link ?? env.SITE_URL);
  const text = encodeURIComponent(String(vars.share_text ?? ""));
  if (/facebook/i.test(label)) return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`;
  if (/whatsapp/i.test(label)) return `https://wa.me/?text=${text}%20${encodeURIComponent(link)}`;
  return String(vars.button_url ?? env.SITE_URL);
}

/** Branded HTML (logo header, text, red button, footer with disclaimer + mailing address + unsubscribe) — SRS 7.2. */
export function renderEmail(t: { subject: string; body: string }, vars: Vars, footer: { disclaimer: string; address: string; unsubscribeLabel: string; unsubscribeUrl?: string }) {
  const subject = fill(t.subject, vars);
  const lines = fill(t.body, vars).split("\n");
  const html = lines
    .map((l) => {
      const btns = l.match(/\[[^\]]+\]/g);
      if (btns && l.replace(/\[[^\]]+\]/g, "").trim() === "") {
        return `<p style="margin:18px 0">${btns
          .map((b) => { const label = b.slice(1, -1); return `<a href="${esc(buttonHref(label, vars))}" style="display:inline-block;background:#e5262f;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;margin:0 6px 6px 0">${esc(label)}</a>`; })
          .join("")}</p>`;
      }
      return l.trim() ? `<p style="margin:0 0 10px">${esc(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1556e0">$1</a>')}</p>` : "";
    })
    .join("");
  const unsub = footer.unsubscribeUrl ? `<p style="margin:6px 0 0"><a href="${esc(footer.unsubscribeUrl)}" style="color:#1556e0">${esc(footer.unsubscribeLabel)}</a></p>` : "";
  const full = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif;color:#334155">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#0a1a45;padding:18px 24px;color:#fff;font-weight:800;font-size:20px;letter-spacing:.5px">GRYSOSTA<span style="font-size:10px;color:#b6d2ff;margin-left:8px;letter-spacing:2px">STOCK TRADING ACADEMY</span></td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:1.6">${html}</td></tr>
<tr><td style="background:#f8fafc;padding:16px 24px;font-size:11px;line-height:1.5;color:#64748b">⚠️ ${esc(footer.disclaimer)}<br/>${esc(footer.address)}${unsub}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${fill(t.body, vars).replace(/\[([^\]]+)\]/g, (_m, l) => `${l}: ${buttonHref(l, vars)}`)}\n\n${footer.disclaimer}\n${footer.address}${footer.unsubscribeUrl ? `\n${footer.unsubscribeLabel}: ${footer.unsubscribeUrl}` : ""}`;
  return { subject, html: full, text };
}
