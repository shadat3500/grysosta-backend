import { round2 } from "../../common/utils/money";

/**
 * Commission per qualifying sale.
 * - "flat" (client decision, default): a fixed $ amount (commissionFlat, $3.50).
 * - "percent" (legacy SRS 9.3): base × commission% / 100, base = after discount (or net of Etsy fees).
 */
export function calcCommission(
  orderValue: number,
  discount: number,
  s: { commissionMode?: string; commissionFlat?: number; commissionBase: string; etsyFeePercent: number; commissionPercent: number },
) {
  let base = round2(orderValue - discount);
  if (s.commissionMode === "flat") return { base, amount: round2(s.commissionFlat ?? 3.5) };
  if (s.commissionBase === "net") base = round2(base * (1 - s.etsyFeePercent / 100));
  return { base, amount: round2((base * s.commissionPercent) / 100) };
}
