import { esc } from './label-sheet';
import { moneyText } from './money';
import { TOTALS_HEADER, TOTALS_TITLE, type HistorySheet } from './history-export-core';
import { HISTORY_PDF_HELP } from './history-export-url';

/**
 * THE HISTORY AS A PAGE READY TO PRINT (22/11, F5) — «PDF» with no library and no server-side PDF: the browser's own print dialog
 * prints it or saves it («حفظ كـ PDF»), exactly as the waybills page does (lib/label-sheet).
 *
 * A whole document of its own, answered by the history door: its styles are INSIDE it, so no stylesheet of any other page grows by a
 * byte, and it runs no code of the app — one line of script presses the print button. A4 across (the lists have up to thirteen
 * columns), Arabic right to left, the header repeated on every page, and the totals per currency at the end.
 */

const STYLE = `
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #111; }
  body { font-family: Tahoma, "Segoe UI", Arial, sans-serif; font-size: 11px; padding: 12px; }
  header { border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 14px 0 4px; }
  .company { font-size: 13px; font-weight: bold; }
  .filters { margin: 4px 0 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px 14px; color: #333; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
  .bar button { font: inherit; font-size: 13px; padding: 8px 16px; min-height: 44px; border: 1px solid #111; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
  .bar p { margin: 0; color: #333; }
  .scroll { overflow-x: auto; }
  .rows { width: 100%; border-spacing: 0; border: solid #999; border-width: 1px 1px 0 0; }
  .rows th, .rows td { border: solid #999; border-width: 0 0 1px 1px; padding: 3px 5px; text-align: right; vertical-align: top; }
  .rows th { background: #eee; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  td.num { direction: ltr; text-align: left; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.date { white-space: nowrap; direction: ltr; text-align: right; }
  .empty { padding: 16px; text-align: center; color: #555; }
  .rows.totals { width: auto; min-width: 50%; }
  @media print { .bar { display: none; } body { padding: 0; } .scroll { overflow: unset; } }
`;

export interface PrintHeader {
  companyName: string;
  storeName: string | null;
  filtersAr: string[];
  printedAt: string;
}

/** The cells of a row as a person reads them: money with its separators and its currency's decimals, Western digits. */
function cellHtml(value: unknown, minor: number | undefined, col: number, dateCols: number): string {
  if (typeof value === 'number' && minor !== undefined) return `<td class="num">${esc(moneyText(value, null, minor))}</td>`;
  if (col < dateCols) return `<td class="date">${esc(String(value ?? ''))}</td>`;
  return `<td>${esc(value === null || value === undefined ? '' : String(value))}</td>`;
}

export function renderHistoryPage(sheet: HistorySheet, head: PrintHeader): string {
  const title = `${sheet.title} — ${head.companyName}`;
  const rows = sheet.rows
    .map((r) => `<tr>${r.cells.map((c, i) => cellHtml(c, r.minors[i], i, 2)).join('')}</tr>`)
    .join('\n');
  const totals = sheet.totals.length
    ? `<h2>${esc(TOTALS_TITLE)}</h2>
<table class="rows totals"><thead><tr>${TOTALS_HEADER.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
${sheet.totals
  .map(
    (t) =>
      `<tr><td>${esc(t.label)}</td><td>${esc(t.currency)}</td><td class="num">${esc(moneyText(t.amount, null, t.minorUnit))}</td><td class="num">${t.count}</td></tr>`
  )
  .join('\n')}
</tbody></table>`
    : '';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body>
<div class="bar"><button type="button" id="print">اطبع أو احفظ PDF</button><p>${esc(HISTORY_PDF_HELP)}</p></div>
<header>
  <div class="company">${esc(head.companyName)}${head.storeName ? ` — ${esc(head.storeName)}` : ''}</div>
  <h1>${esc(sheet.title)}</h1>
  <ul class="filters">${head.filtersAr.map((f) => `<li>${esc(f)}</li>`).join('')}<li>${esc(`عدد السطور: ${sheet.rows.length}`)}</li><li>${esc(`طُبع: ${head.printedAt}`)}</li></ul>
</header>
<div class="scroll"><table class="rows">
<thead><tr>${sheet.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
<tbody>
${rows || `<tr><td class="empty" colspan="${sheet.header.length}">ما في سطور بهالفلاتر.</td></tr>`}
</tbody></table></div>
${totals}
<script>document.getElementById('print').addEventListener('click', function () { window.print(); });</script>
</body></html>`;
}

/** A refusal said on a page of its own: the button opened a new tab, and a raw JSON there says nothing to a person. */
export function renderHistoryRefusal(errorAr: string): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ما انطبع السجل</title><style>${STYLE}</style></head>
<body><h1>ما انطبع السجل</h1><p>${esc(errorAr)}</p></body></html>`;
}
