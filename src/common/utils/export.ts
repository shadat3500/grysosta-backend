import type { Response } from "express";
import * as XLSX from "xlsx";

/** SRS 8 A13 / 14.4: CSV with UTF-8 BOM (Spanish accents open correctly in Excel) or real .xlsx. */
export function sendExport(res: Response, rows: Record<string, unknown>[], name: string, format: "csv" | "xlsx", columns?: string[]) {
  // Empty result: still send the header row so the file opens with the right columns.
  const ws = rows.length || !columns ? XLSX.utils.json_to_sheet(rows.length ? rows : [{ info: "No rows" }]) : XLSX.utils.json_to_sheet([], { header: columns });
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "xlsx") {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 30));
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}-${stamp}.xlsx"`);
    return res.send(buf);
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${stamp}.csv"`);
  return res.send("﻿" + XLSX.utils.sheet_to_csv(ws));
}
