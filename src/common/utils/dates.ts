export const dayKey = (d: Date = new Date()) => d.toISOString().slice(0, 10);
export const startOfDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Etsy exports dates like 11/02/26; also accepts ISO. */
export function parseEtsyDate(v: string) {
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2]), 12));
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
