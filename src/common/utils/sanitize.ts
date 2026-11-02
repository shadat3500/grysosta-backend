/**
 * Minimal allow-list HTML sanitizer for admin rich text (bold, italic, underline, links, lists, headings, paragraphs).
 * Strips scripts, event handlers and javascript: URLs (SRS 11.2 — output escaped, no XSS).
 */
const ALLOWED = new Set(["b", "strong", "i", "em", "u", "a", "ul", "ol", "li", "p", "br", "h2", "h3", "div", "span"]);

export function sanitizeHtml(html: string) {
  return html
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (m, tag: string, attrs: string) => {
      const t = tag.toLowerCase();
      if (!ALLOWED.has(t)) return "";
      if (m.startsWith("</")) return `</${t}>`;
      if (t === "a") {
        const href = /href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
        const safe = /^(https?:|mailto:|#|\/)/i.test(href.trim()) ? href.replace(/"/g, "&quot;") : "#";
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer">`;
      }
      return `<${t}>`;
    });
}
