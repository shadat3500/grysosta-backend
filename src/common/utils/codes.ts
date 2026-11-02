const BLOCKED = ["SHIT", "FUCK", "DAMN", "PUTA", "PUTO", "MIERDA", "CACA", "PENE", "SEX", "ASS", "BITCH", "CULO", "PEDO", "NAZI", "KKK", "DICK", "COCK"];

export const hasBlockedWord = (code: string) => BLOCKED.some((w) => code.toUpperCase().includes(w));

/** Etsy codes allow letters and numbers only. */
export const normalizeCode = (c: string) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** SRS 6.3 — GSTA + first name (A–Z, max 8) + 2 random digits. Uniqueness is checked by the caller. */
export function codeCandidate(firstName: string, attempt = 0) {
  let base = firstName.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  if (!base || hasBlockedWord(base)) base = "VIP";
  const digits = attempt < 80 ? String(Math.floor(Math.random() * 100)).padStart(2, "0") : String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `GSTA${base}${digits}`;
}
