import { round2 } from "../../common/utils/money";

/** SRS 9.3 — commission = base × commission% / 100, base = after discount (default) or net of Etsy fees. */
export function calcCommission(orderValue: number, discount: number, s: { commissionBase: string; etsyFeePercent: number; commissionPercent: number }) {
  let base = orderValue - discount;
  if (s.commissionBase === "net") base = base * (1 - s.etsyFeePercent / 100);
  base = round2(base);
  return { base, amount: round2((base * s.commissionPercent) / 100) };
}
