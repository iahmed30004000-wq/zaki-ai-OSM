/**
 * THE DEBT COUNTER — A NUMBER PER FILE AND PER KIND THAT CAN ONLY GO DOWN.
 *
 * The restructure moves every screen onto one kit, one screen at a time, by hand. What it must never do is move
 * BACKWARDS while it does: a button written raw because the kit one was a click away, a card drawn from the card colour
 * because copying a line is quicker than importing a component. So what is still written by hand is counted, here, per
 * file and per kind, and the number is pinned in `scripts/ui-debt.json` — per-file rows ONLY; the totals are added up from
 * them when printed, never stored (a stored block made every two screen PRs conflict on the same lines).
 *
 *   npx tsx scripts/ui-debt.ts                  # prints the totals (summed from the files) against the pinned ceilings
 *   npx tsx scripts/ui-debt.ts --write          # pins a LOWER number; REFUSES any file that rose
 *   npx tsx scripts/ui-debt.ts --explain <file> # every raw control in the file, its line, and the kit part that replaces it
 *
 * R19 (19/11) — THE ALLOWED LIST. Five of the six kinds (everything but `textXs`) are now pinned to ZERO outside one list,
 * `ALLOWED` below: a raw control that is right to stay raw (a row press, a drag handle, a chip, a date field inside a form, the
 * storefront owner's files until R18), each with its sentence in plain Arabic. The list is written HERE, in this file, and nowhere
 * else: `--write` copies it into `scripts/ui-debt.json` (`allowed`) and never reads it back from there, so the JSON can be
 * regenerated but not edited. A file's number outside the list must be zero; a list count above the truth is a stale entry.
 * `--write` refuses to pin while either is wrong. `textXs` is NOT in the list — it keeps «only falls».
 *
 * `src/lib/ui-debt.test.ts` fails on a rise AND on a fall nobody registered (a number that fell and was not pinned is a
 * ceiling that has quietly become higher than the truth, and the next rise would hide under it).
 *
 * WHAT IS COUNTED, AND NOT COUNTED. The files are the SAME ones `scripts/ui-inventory.ts` walks (it exports the list; there is
 * no second list to drift), minus the kit itself (`src/components/ui/` is where a raw button is MEANT to be) and minus the
 * seller's own surfaces (`SELLER_SURFACES`: a shop is the seller's design, not ours). Comments are blanked first, line count
 * preserved, so a sentence that names a tag is not a tag. A file's line endings change nothing: CRLF is read as LF.
 *
 * It is text, not a parser. The question is never «how many buttons render» but «did this edit write one more by hand».
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { uiFilePaths } from './ui-inventory';
import { SELLER_SURFACES, stripComments } from '../src/lib/guard-source';

const ROOT = process.cwd();

export const DEBT_PATH = join(ROOT, 'scripts', 'ui-debt.json');

/**
 * The kinds, in the order the registry writes them.
 *
 *   rawButtons      a `<button` that is not the kit's `Button` (`<Button` is the kit's and is not debt)
 *   rawCheckboxes   an `<input type="checkbox">` — the kit's `Checkbox` / `Switch` (R2b) replaces it
 *   rawSurfaces     a card or panel drawn by hand: the card fill, a border and the surface corner on one class string
 *   rawDatePickers  an `<input type="date | datetime-local | month">` — the kit's `DateRange` (R2c) replaces it
 *   screenTitle     a `<ScreenTitle` — the second page-title component; `PageHeader` replaces it (R3)
 *   textXs          every `text-xs` — body text is `text-sm`, a caption is `text-note`
 */
export const DEBT_KINDS = ['rawButtons', 'rawCheckboxes', 'rawSurfaces', 'rawDatePickers', 'screenTitle', 'textXs'] as const;
export type DebtKind = (typeof DEBT_KINDS)[number];
export type DebtCounts = Record<DebtKind, number>;
/** What the registry holds for a file: only the kinds above zero. */
export type DebtRow = Partial<DebtCounts>;

/**
 * R19 — the kinds pinned to ZERO outside `ALLOWED`. `textXs` is left out on purpose: a caption is `text-note`, but some `text-xs`
 * are legitimate small labels, so it keeps «only falls» and is never forced to zero.
 */
export const ZERO_KINDS = ['rawButtons', 'rawCheckboxes', 'rawSurfaces', 'rawDatePickers', 'screenTitle'] as const satisfies readonly DebtKind[];
export type ZeroKind = (typeof ZERO_KINDS)[number];

/** One raw control that is right to stay raw: where, what kind, HOW MANY, and why — in plain Arabic, at least `MIN_WHY` characters. */
export interface AllowedEntry {
  file: string;
  kind: ZeroKind;
  count: number;
  why: string;
}

export const MIN_WHY = 20;

/**
 * The registry holds ONLY the per-file rows. 18/11: it used to open with a stored `totals` block; every screen PR changed
 * those adjacent lines, so any two PRs conflicted on this file. The totals are now COMPUTED (`totalsOf`) wherever they
 * are printed or tested, and a registry that carries a `totals` key again is refused (`parseRegistry`).
 */
export interface Registry {
  files: Record<string, DebtRow>;
  /** R19: the allowed list, copied from `ALLOWED` below by `render`. */
  allowed: AllowedEntry[];
}

export interface Hit {
  kind: DebtKind;
  line: number;
  /** What was found, trimmed to one line. */
  text: string;
  /** The kit part that replaces it — a suggestion for whoever migrates the file, never something a test enforces. */
  use: string;
}

// ───────────────────────── reading source ─────────────────────────

const lineOf = (src: string, index: number): number => {
  let n = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
};

/** The `>` that closes the tag opened at `from`: braces and quotes are skipped, so an `=>` inside `onClick={…}` does not end it. */
function tagEnd(src: string, from: number): number {
  let depth = 0;
  let quote = '';
  const stop = Math.min(src.length, from + 3000);
  for (let i = from; i < stop; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth <= 0) return i;
  }
  return stop - 1;
}

const oneLine = (s: string, max = 110) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A raw button's replacement, read from the words on its own tag. A hint: the file's owner decides. */
function buttonUse(tag: string): string {
  if (/role=["']tab["']/.test(tag)) return 'Tabs (أو Segmented لزوج مضغوط)';
  if (/role=["']switch["']/.test(tag)) return 'Switch';
  if (/aria-pressed/.test(tag)) return 'Segmented (أو Switch إن كان تشغيلاً وإطفاءً)';
  if (/aria-label=/.test(tag) && !/\b(px-[2-9]|px-1\.5)\b/.test(tag)) return 'IconButton (بتسمية)';
  if (/--sys-destructive/.test(tag) && /bg-\[/.test(tag)) return 'Button variant="danger"';
  if (/bg-\[var\(--sys-primary\)\]/.test(tag)) return 'Button variant="primary"';
  if (/(?<![\w-])border(?![\w-])/.test(tag)) return 'Button variant="secondary"';
  if (/text-xs|underline|text-\[var\(--sys-primary\)\]/.test(tag)) return 'Button variant="quiet" size="sm"';
  return 'Button — أو ضغطة صف تبقى خاماً وتدخل القائمة المسموحة بجملة';
}

// ───────────────────────── the hands that write a surface ─────────────────────────

/** The card and panel fills. A field wears the same fill, which is why a field is told apart below. */
const FILL = /bg-\[var\(--sys-(?:card|surface|surface-strong)\)\]/g;
const QUOTE = /['"`]/;
/** What marks a class string as a CONTROL'S, not a surface's: it takes focus or shows a placeholder. */
const FIELD_WORDS = /outline-none|focus:|placeholder|appearance-none|resize-/;
const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button', 'Input', 'Select', 'Textarea', 'Button']);

function surfaceHits(src: string): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<number>();
  for (const m of src.matchAll(FILL)) {
    const at = m.index!;
    // The class string around the match: from the quote before it to the quote after it.
    let left = at;
    while (left > 0 && !QUOTE.test(src[left - 1])) left--;
    let right = at + m[0].length;
    while (right < src.length && !QUOTE.test(src[right])) right++;
    if (seen.has(left)) continue;
    seen.add(left);
    const chunk = src.slice(left, right);
    if (!/(?<![\w-])rounded-lg(?![\w-])/.test(chunk)) continue; // the surface corner (shape-scale: lg = a surface)
    if (!/(?<![\w:-])border(?![\w-])/.test(chunk)) continue; // an edge, not a fill alone
    if (FIELD_WORDS.test(chunk)) continue;
    // A control's own class: the nearest opening tag before the string.
    const before = src.slice(Math.max(0, left - 700), left);
    const tags = [...before.matchAll(/<([A-Za-z][\w.]*)/g)];
    const owner = tags.length ? tags[tags.length - 1][1] : '';
    if (CONTROL_TAGS.has(owner)) continue;
    const plain = /divide-y|p-0|overflow-hidden/.test(chunk);
    hits.push({
      kind: 'rawSurfaces',
      line: lineOf(src, left),
      text: oneLine(chunk),
      use: plain ? 'Card plain (سطح متداخل أو كثيف)' : 'Card (سطح مستوى صفحة) — أو Card plain إن كان متداخلاً',
    });
  }
  return hits;
}

// ───────────────────────── the whole of one file ─────────────────────────

/** Every hit in one file's source, in line order. The counts are exactly these: what `--explain` lists is what the registry pins. */
export function hitsOf(source: string): Hit[] {
  const src = stripComments(source.replace(/\r\n/g, '\n'));
  const hits: Hit[] = [];

  for (const m of src.matchAll(/<button(?=[\s>/])/g)) {
    const tag = src.slice(m.index!, tagEnd(src, m.index!) + 1);
    hits.push({ kind: 'rawButtons', line: lineOf(src, m.index!), text: oneLine(tag), use: buttonUse(tag) });
  }

  for (const m of src.matchAll(/<input(?=[\s>/])/g)) {
    const tag = src.slice(m.index!, tagEnd(src, m.index!) + 1);
    if (/\btype\s*=\s*\{?\s*["']checkbox["']/.test(tag)) {
      hits.push({
        kind: 'rawCheckboxes',
        line: lineOf(src, m.index!),
        text: oneLine(tag),
        use: 'Checkbox (علامة اختيار) — أو Switch إن كان تشغيلاً وإطفاءً',
      });
    } else if (/\btype\s*=\s*\{?\s*["'](?:date|datetime-local|month)["']/.test(tag)) {
      hits.push({ kind: 'rawDatePickers', line: lineOf(src, m.index!), text: oneLine(tag), use: 'DateRange' });
    }
  }

  hits.push(...surfaceHits(src));

  for (const m of src.matchAll(/<ScreenTitle(?=[\s>/])/g)) {
    hits.push({ kind: 'screenTitle', line: lineOf(src, m.index!), text: oneLine(src.slice(m.index!, tagEnd(src, m.index!) + 1)), use: 'PageHeader' });
  }

  for (const m of src.matchAll(/(?<![\w-])text-xs(?![\w-])/g)) {
    hits.push({ kind: 'textXs', line: lineOf(src, m.index!), text: 'text-xs', use: 'text-sm للنص، وtext-note للتعليق' });
  }

  return hits.sort((a, b) => a.line - b.line);
}

export function countsOf(source: string): DebtCounts {
  const counts = Object.fromEntries(DEBT_KINDS.map((k) => [k, 0])) as DebtCounts;
  for (const h of hitsOf(source)) counts[h.kind]++;
  return counts;
}

// ───────────────────────── the allowed list ─────────────────────────

/*ALLOWED-START*/
/** The sentences, written once: an entry names the ones that fit it (a file with two kinds of control names two). */
const W = {
  owner: 'ملف صاحب المتجر لحد R18',
  drag: 'مقبض سحب لإعادة الترتيب: بيمرّر مراجع ومستمعي السحب للعنصر نفسه، والزر الجاهز ما بمرّرها',
  disclosure: 'رأس قسم بيفتح ويسكّر: الصف كله هو الزر وفيه أكثر من نص',
  pick: 'خيار من مجموعة أو تبويب بلونه بيتبدّل حسب المختار — شريحة اختيار مش زر إجراء',
  icon: 'زر أيقونة لوحده بتسمية للقارئ وحجم لمس مضبوط لمكانه',
  row: 'ضغطة صف أو بطاقة كاملة: الصف كله زر وفيه محتوى متعدد، مش زر بنص',
  primary: 'زر إجراء أساسي بلون العلامة كتبته الشاشة بيدها — بديله الزر الأساسي من العدّة، وبينرحّل مع شاشته',
  secondary: 'زر إجراء بإطار كتبته الشاشة بيدها — بديله الزر الثانوي من العدّة، وبينرحّل مع شاشته',
  quiet: 'رابط أو زر هادئ بلا إطار كتبته الشاشة بيدها — بديله الزر الهادئ من العدّة، وبينرحّل مع شاشته',
  chipState: 'شريحة لونها وإطارها بيتبدّلوا حسب الحالة، مش زر بشكل ثابت',
  custom: 'ضغطة بشكل مخصّص (رابط أو شريحة أو مقبض) بتاخد مظهرها من مكان استعمالها، مش من زر العدّة',
  setting: 'خانة تشغيل لإعداد داخل بطاقة إعدادات، مربوطة بنص مجاور وبتنحفظ فوراً',
  form: 'خانة اختيار أصلية داخل نموذج بنص مجاور — بتنرحّل للمكوّن الجاهز مع شاشتها',
  date: 'حقل تاريخ واحد داخل نموذج: مش مدى تواريخ، فمكوّن المدى ما بنفع مكانه',
  fixed: 'ورقة أو لوحة عائمة بموقع ثابت فوق الصفحة، مش بطاقة بمكانها',
  dynamic: 'سطح لونه وإطاره بيتبدّلوا حسب الحالة، وبطاقة العدّة بلون واحد',
  mono: 'رقعة صغيرة بخط ثابت لعرض رمز أو قيمة، مش بطاقة',
  tile: 'مربع أيقونة صغير بقياس ثابت، مش بطاقة',
  chip: 'شريحة أو رابط بإطار وحجم لمس، مش بطاقة صفحة',
  note: 'مربع ملاحظة أو تلميح صغير بخلفية السطح، مش بطاقة صفحة',
  list: 'حاوية قائمة بخطوط فاصلة وحواف مقصوصة — شكلها جزء من القائمة',
  card: 'بطاقة بإطار وخلفية كتبتها الشاشة بيدها — بديلها بطاقة العدّة، وبتنرحّل مع شاشتها',
} as const;

const why = (...parts: string[]) => parts.join('؛ ');

/**
 * Every raw control that is right to stay raw, 19/11 (R19c). Counts are EXACT: a count above what is written is a stale entry
 * and fails the test; one more control than listed fails it too. Add a line here only with a real reason, in plain Arabic.
 */
export const ALLOWED: readonly AllowedEntry[] = [
  { file: 'src/app/(system)/error.tsx', kind: 'rawSurfaces', count: 1, why: W.card },
  { file: 'src/app/(system)/not-found.tsx', kind: 'rawSurfaces', count: 2, why: why(W.card, W.tile) },
  { file: 'src/app/forbidden.tsx', kind: 'rawSurfaces', count: 1, why: W.card },
  { file: 'src/components/ai/AiDock.tsx', kind: 'rawButtons', count: 1, why: W.icon },
  { file: 'src/components/attendance/ShiftChip.tsx', kind: 'rawButtons', count: 2, why: W.chipState },
  { file: 'src/components/attendance/ShiftChip.tsx', kind: 'rawSurfaces', count: 1, why: W.chip },
  { file: 'src/components/carts/cart-parts.tsx', kind: 'rawSurfaces', count: 1, why: W.chip },
  { file: 'src/components/confirmation/CallHelperCard.tsx', kind: 'rawSurfaces', count: 1, why: W.card },
  { file: 'src/components/confirmation/CallOutcomeSheet.tsx', kind: 'rawButtons', count: 1, why: W.icon },
  { file: 'src/components/confirmation/CallOutcomeSheet.tsx', kind: 'rawSurfaces', count: 1, why: W.fixed },
  { file: 'src/components/confirmation/WhatsAppAfterNoAnswer.tsx', kind: 'rawButtons', count: 1, why: W.primary },
  { file: 'src/components/confirmation/WinbackRuleDialog.tsx', kind: 'rawCheckboxes', count: 2, why: W.form },
  { file: 'src/components/dashboard/DetailsLinks.tsx', kind: 'rawSurfaces', count: 1, why: W.chip },
  { file: 'src/components/dashboard/MissionCard.tsx', kind: 'rawSurfaces', count: 1, why: W.card },
  { file: 'src/components/dashboard/WorkToday.tsx', kind: 'rawSurfaces', count: 2, why: why(W.card, W.dynamic) },
  { file: 'src/components/growth/AskAi.tsx', kind: 'rawSurfaces', count: 1, why: W.chip },
  { file: 'src/components/growth/CampaignsBoard.tsx', kind: 'rawButtons', count: 1, why: W.drag },
  { file: 'src/components/growth/CampaignsBoard.tsx', kind: 'rawSurfaces', count: 4, why: why(W.chip, W.note, W.list, W.card) },
  { file: 'src/components/growth/IntelligenceStrip.tsx', kind: 'rawSurfaces', count: 1, why: W.card },
  { file: 'src/components/inventory/OpeningStockCount.tsx', kind: 'rawDatePickers', count: 1, why: W.date },
  { file: 'src/components/landing-editor/Advanced.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/AfterOrderPanel.tsx', kind: 'rawButtons', count: 6, why: W.owner },
  { file: 'src/components/landing-editor/AfterOrderPanel.tsx', kind: 'rawCheckboxes', count: 5, why: W.owner },
  { file: 'src/components/landing-editor/AfterOrderPanel.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/AiCopyPanel.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/AiCopyPanel.tsx', kind: 'rawCheckboxes', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/AiCopyPanel.tsx', kind: 'rawSurfaces', count: 2, why: W.owner },
  { file: 'src/components/landing-editor/BlockBuilder.tsx', kind: 'rawButtons', count: 29, why: W.owner },
  { file: 'src/components/landing-editor/BlockBuilder.tsx', kind: 'rawCheckboxes', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/BlockBuilder.tsx', kind: 'rawSurfaces', count: 7, why: W.owner },
  { file: 'src/components/landing-editor/BuildMyLandingPage.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/BuildMyLandingPage.tsx', kind: 'rawCheckboxes', count: 2, why: W.owner },
  { file: 'src/components/landing-editor/BuildMyLandingPage.tsx', kind: 'rawSurfaces', count: 2, why: W.owner },
  { file: 'src/components/landing-editor/EditorPanes.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/SelectionBar.tsx', kind: 'rawButtons', count: 12, why: W.owner },
  { file: 'src/components/landing-editor/SelectionBar.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/SlidesField.tsx', kind: 'rawButtons', count: 2, why: W.owner },
  { file: 'src/components/landing-editor/StoreThemePreview.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/StoreThemePreview.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
  { file: 'src/components/landing-editor/UndoBar.tsx', kind: 'rawButtons', count: 2, why: W.owner },
  { file: 'src/components/landing-flow/CreateWizard.tsx', kind: 'rawButtons', count: 5, why: W.owner },
  { file: 'src/components/landing-flow/CreateWizard.tsx', kind: 'rawSurfaces', count: 4, why: W.owner },
  { file: 'src/components/landing-flow/DesignCards.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/ops/DelayShipmentDialog.tsx', kind: 'rawButtons', count: 2, why: why(W.pick, W.row) },
  { file: 'src/components/ops/DelayShipmentDialog.tsx', kind: 'rawDatePickers', count: 1, why: W.date },
  { file: 'src/components/orders/AiOrderModal.tsx', kind: 'rawCheckboxes', count: 1, why: W.form },
  { file: 'src/components/orders/AiOrderModal.tsx', kind: 'rawSurfaces', count: 1, why: W.mono },
  { file: 'src/components/orders/ChangeRequestReview.tsx', kind: 'rawSurfaces', count: 1, why: W.card },
  { file: 'src/components/orders/ContactButtons.tsx', kind: 'rawButtons', count: 3, why: why(W.custom, W.icon, W.row) },
  { file: 'src/components/orders/ContactButtons.tsx', kind: 'rawSurfaces', count: 1, why: W.fixed },
  { file: 'src/components/orders/CopyValue.tsx', kind: 'rawButtons', count: 1, why: W.icon },
  { file: 'src/components/orders/CourierNotifyDialog.tsx', kind: 'rawButtons', count: 4, why: why(W.quiet, W.secondary, W.primary) },
  { file: 'src/components/orders/CreateOrderModal.tsx', kind: 'rawCheckboxes', count: 2, why: W.form },
  { file: 'src/components/orders/CreateOrderModal.tsx', kind: 'rawSurfaces', count: 1, why: W.card },
  { file: 'src/components/orders/CustomerHistory.tsx', kind: 'rawButtons', count: 1, why: W.chipState },
  { file: 'src/components/orders/ImportOrdersDialog.tsx', kind: 'rawButtons', count: 4, why: why(W.secondary, W.pick, W.primary) },
  { file: 'src/components/orders/ImportOrdersDialog.tsx', kind: 'rawCheckboxes', count: 1, why: W.form },
  { file: 'src/components/orders/LinesRequestReview.tsx', kind: 'rawButtons', count: 2, why: W.secondary },
  { file: 'src/components/orders/MigrateOrdersDialog.tsx', kind: 'rawButtons', count: 3, why: why(W.secondary, W.primary) },
  { file: 'src/components/orders/MigrateOrdersDialog.tsx', kind: 'rawDatePickers', count: 1, why: W.date },
  { file: 'src/components/orders/OrderNotesPeek.tsx', kind: 'rawButtons', count: 1, why: W.secondary },
  { file: 'src/components/orders/OrderNotesPeek.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/orders/OrderRef.tsx', kind: 'rawButtons', count: 1, why: W.quiet },
  { file: 'src/components/orders/ProductLinesEditor.tsx', kind: 'rawButtons', count: 5, why: why(W.icon, W.secondary) },
  { file: 'src/components/orders/RatingLinkButton.tsx', kind: 'rawButtons', count: 1, why: W.quiet },
  { file: 'src/components/orders/RatingLinkButton.tsx', kind: 'rawSurfaces', count: 1, why: W.card },
  { file: 'src/components/production/BatchCostDialog.tsx', kind: 'rawButtons', count: 2, why: why(W.quiet, W.icon) },
  { file: 'src/components/products/ProductOffers.tsx', kind: 'rawButtons', count: 1, why: W.drag },
  { file: 'src/components/scan/ScanButton.tsx', kind: 'rawButtons', count: 3, why: why(W.custom, W.pick, W.primary) },
  { file: 'src/components/screens/AgentCustodyScreen.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/AiSettingsScreen.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/CampaignsScreen.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/CampaignsScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/screens/CommissionSettingsScreen.tsx', kind: 'rawDatePickers', count: 2, why: W.date },
  { file: 'src/components/screens/GeoSettingsScreen.tsx', kind: 'rawSurfaces', count: 2, why: W.tile },
  { file: 'src/components/screens/InstalledAppsScreen.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/IntelligenceScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.dynamic },
  { file: 'src/components/screens/InventoryBalancesScreen.tsx', kind: 'rawButtons', count: 1, why: W.pick },
  { file: 'src/components/screens/InventoryBalancesScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.dynamic },
  { file: 'src/components/screens/JobsScreen.tsx', kind: 'rawSurfaces', count: 2, why: why(W.mono, W.dynamic) },
  { file: 'src/components/screens/LandingLibraryScreen.tsx', kind: 'rawButtons', count: 3, why: W.owner },
  { file: 'src/components/screens/LandingLibraryScreen.tsx', kind: 'rawSurfaces', count: 2, why: W.owner },
  { file: 'src/components/screens/LandingPageDetailScreen.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/screens/LandingPageDetailScreen.tsx', kind: 'rawSurfaces', count: 6, why: W.owner },
  { file: 'src/components/screens/LandingPageEditorScreen.tsx', kind: 'rawButtons', count: 14, why: W.owner },
  { file: 'src/components/screens/LandingPageEditorScreen.tsx', kind: 'rawSurfaces', count: 4, why: W.owner },
  { file: 'src/components/screens/LandingPagesScreen.tsx', kind: 'rawButtons', count: 8, why: W.owner },
  { file: 'src/components/screens/PermissionsScreen.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/PreparationScreen.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/PreparationScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.tile },
  { file: 'src/components/screens/ProductDetailScreen.tsx', kind: 'rawButtons', count: 2, why: W.icon },
  { file: 'src/components/screens/SettingsHomeScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/screens/ShipmentsNewScreen.tsx', kind: 'rawDatePickers', count: 1, why: W.date },
  { file: 'src/components/screens/ShippingBatchesScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.chip },
  { file: 'src/components/screens/StoreDomainScreen.tsx', kind: 'rawButtons', count: 2, why: W.owner },
  { file: 'src/components/screens/StoreDomainScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
  { file: 'src/components/screens/StoreLanguagesScreen.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/screens/StoreLanguagesScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
  { file: 'src/components/screens/StoreMenusScreen.tsx', kind: 'rawButtons', count: 5, why: W.owner },
  { file: 'src/components/screens/StoreMenusScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
  { file: 'src/components/screens/StorePagesScreen.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/screens/StorePagesScreen.tsx', kind: 'rawCheckboxes', count: 1, why: W.owner },
  { file: 'src/components/screens/StorePagesScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
  { file: 'src/components/screens/StoreReviewsScreen.tsx', kind: 'rawSurfaces', count: 2, why: W.owner },
  { file: 'src/components/screens/StoreRoutesScreen.tsx', kind: 'rawButtons', count: 2, why: W.owner },
  { file: 'src/components/screens/StoreRoutesScreen.tsx', kind: 'rawSurfaces', count: 2, why: W.owner },
  { file: 'src/components/screens/StoreSearchScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
  { file: 'src/components/screens/StoreThemeScreen.tsx', kind: 'rawButtons', count: 11, why: W.owner },
  { file: 'src/components/screens/StoreThemeScreen.tsx', kind: 'rawCheckboxes', count: 10, why: W.owner },
  { file: 'src/components/screens/StoreThemeScreen.tsx', kind: 'rawSurfaces', count: 5, why: W.owner },
  { file: 'src/components/screens/StoresScreen.tsx', kind: 'rawButtons', count: 8, why: W.owner },
  { file: 'src/components/screens/StoresScreen.tsx', kind: 'rawSurfaces', count: 2, why: W.owner },
  { file: 'src/components/screens/TeamLeaderAudit.tsx', kind: 'rawDatePickers', count: 1, why: W.date },
  { file: 'src/components/screens/TelegramSettingsScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/screens/TrackingScreen.tsx', kind: 'rawButtons', count: 4, why: why(W.pick, W.quiet) },
  { file: 'src/components/screens/UserDetailScreen.tsx', kind: 'rawButtons', count: 1, why: W.pick },
  { file: 'src/components/screens/WhatsAppInboxScreen.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/confirmation/ActionDialogs.tsx', kind: 'rawButtons', count: 1, why: W.pick },
  { file: 'src/components/screens/confirmation/ActionDialogs.tsx', kind: 'rawDatePickers', count: 2, why: W.date },
  { file: 'src/components/screens/confirmation/AssistantDialog.tsx', kind: 'rawButtons', count: 1, why: W.quiet },
  { file: 'src/components/screens/confirmation/AssistantDialog.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/screens/finance/ClosingScreen.tsx', kind: 'rawDatePickers', count: 1, why: W.date },
  { file: 'src/components/screens/finance/CollectionScreen.tsx', kind: 'rawSurfaces', count: 1, why: W.chip },
  { file: 'src/components/screens/finance/LinkLineDialog.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/finance/MatchingScreen.tsx', kind: 'rawButtons', count: 1, why: W.disclosure },
  { file: 'src/components/screens/finance/SearchAllStatements.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/finance/SwapDialog.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/screens/finance/WalletLookDialog.tsx', kind: 'rawButtons', count: 2, why: W.pick },
  { file: 'src/components/screens/finance/WalletsScreen.tsx', kind: 'rawButtons', count: 2, why: why(W.row, W.pick) },
  { file: 'src/components/screens/finance/WalletsScreen.tsx', kind: 'rawDatePickers', count: 2, why: W.date },
  { file: 'src/components/screens/tracking/DeliverDialog.tsx', kind: 'rawButtons', count: 1, why: W.chipState },
  { file: 'src/components/screens/tracking/DifferenceMark.tsx', kind: 'rawButtons', count: 1, why: W.chipState },
  { file: 'src/components/screens/users/UserShift.tsx', kind: 'rawButtons', count: 1, why: W.pick },
  { file: 'src/components/settings/CallProofCard.tsx', kind: 'rawCheckboxes', count: 1, why: W.setting },
  { file: 'src/components/settings/CourierFees.tsx', kind: 'rawSurfaces', count: 1, why: W.dynamic },
  { file: 'src/components/settings/CustomConversionsCard.tsx', kind: 'rawButtons', count: 1, why: W.pick },
  { file: 'src/components/settings/IntakeFilterCard.tsx', kind: 'rawCheckboxes', count: 1, why: W.setting },
  { file: 'src/components/settings/LeadsV2Card.tsx', kind: 'rawCheckboxes', count: 1, why: W.setting },
  { file: 'src/components/settings/MenuOrderCard.tsx', kind: 'rawButtons', count: 2, why: W.drag },
  { file: 'src/components/settings/MessageTemplatesCard.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/settings/PartnersCard.tsx', kind: 'rawCheckboxes', count: 1, why: W.setting },
  { file: 'src/components/settings/PenaltyRulesCard.tsx', kind: 'rawButtons', count: 1, why: W.secondary },
  { file: 'src/components/settings/PenaltyRulesCard.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/settings/PerLineSettlementCard.tsx', kind: 'rawCheckboxes', count: 1, why: W.setting },
  { file: 'src/components/settings/PerformanceSettingsCard.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/settings/PostOrderOfferCard.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/settings/QueueModesCard.tsx', kind: 'rawButtons', count: 1, why: W.primary },
  { file: 'src/components/settings/QueuePriorityCard.tsx', kind: 'rawCheckboxes', count: 1, why: W.setting },
  { file: 'src/components/settings/StorefrontSettings.tsx', kind: 'rawSurfaces', count: 2, why: W.card },
  { file: 'src/components/settings/ThemePicker.tsx', kind: 'rawButtons', count: 1, why: W.pick },
  { file: 'src/components/settings/WinbackV2Card.tsx', kind: 'rawCheckboxes', count: 1, why: W.setting },
  { file: 'src/components/shell/AccountScreens.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/shell/CommandPalette.tsx', kind: 'rawButtons', count: 2, why: why(W.row, W.pick) },
  { file: 'src/components/shell/EntryPicker.tsx', kind: 'rawButtons', count: 2, why: W.row },
  { file: 'src/components/shell/EntryPicker.tsx', kind: 'rawSurfaces', count: 4, why: why(W.tile, W.card) },
  { file: 'src/components/shell/Header.tsx', kind: 'rawButtons', count: 1, why: W.custom },
  { file: 'src/components/shell/Header.tsx', kind: 'rawSurfaces', count: 1, why: W.note },
  { file: 'src/components/shell/InstallApp.tsx', kind: 'rawButtons', count: 1, why: W.custom },
  { file: 'src/components/shell/MobileNav.tsx', kind: 'rawButtons', count: 2, why: why(W.row, W.disclosure) },
  { file: 'src/components/shell/NotificationBell.tsx', kind: 'rawButtons', count: 1, why: W.row },
  { file: 'src/components/shell/Sidebar.tsx', kind: 'rawButtons', count: 4, why: why(W.icon, W.disclosure, W.custom) },
  { file: 'src/components/store-admin/PanelHeader.tsx', kind: 'rawButtons', count: 1, why: W.owner },
  { file: 'src/components/store-admin/PanelHeader.tsx', kind: 'rawSurfaces', count: 1, why: W.owner },
];
/*ALLOWED-END*/

// ───────────────────────── the registry ─────────────────────────

/** A file is in the debt's scope when the census walks it and it is neither the kit nor the seller's own. */
export function inDebtScope(rel: string): boolean {
  const p = `/${rel}`;
  if (p.includes('/components/ui/')) return false;
  return !SELLER_SURFACES.some((s) => p.includes(s));
}

/** The registry's totals, added up from its files — never stored, so they can never disagree with them. */
export const totalsOf = (reg: Registry): DebtCounts => {
  const totals = Object.fromEntries(DEBT_KINDS.map((k) => [k, 0])) as DebtCounts;
  for (const row of Object.values(reg.files)) for (const k of DEBT_KINDS) totals[k] += row[k] ?? 0;
  return totals;
};

/** The allowed list's sums per kind — what `npx tsx scripts/ui-debt.ts` prints beside the totals; they must equal them. */
export const allowedSums = (allowed: readonly AllowedEntry[]): DebtCounts => {
  const sums = Object.fromEntries(DEBT_KINDS.map((k) => [k, 0])) as DebtCounts;
  for (const e of allowed) sums[e.kind] += e.count;
  return sums;
};

export interface AllowedGap {
  file: string;
  kind: DebtKind;
  /** What is written by hand now. */
  truth: number;
  /** What the allowed list says about it. */
  allowed: number;
}

const pairKey = (file: string, kind: string) => `${file}|${kind}`;

/**
 * Where the allowed list and the truth disagree, for the five zero kinds.
 *   unlisted — more is written than the list allows (the number outside the list is not zero): a raw control nobody explained;
 *   stale    — the list allows MORE than is written: an entry that outlived its control, a ceiling above the truth.
 */
export function allowedGaps(now: Registry): { unlisted: AllowedGap[]; stale: AllowedGap[] } {
  const listed = new Map<string, number>();
  for (const e of now.allowed) listed.set(pairKey(e.file, e.kind), (listed.get(pairKey(e.file, e.kind)) ?? 0) + e.count);
  const files = new Set([...Object.keys(now.files), ...now.allowed.map((e) => e.file)]);
  const unlisted: AllowedGap[] = [];
  const stale: AllowedGap[] = [];
  for (const file of [...files].sort()) {
    for (const kind of ZERO_KINDS) {
      const truth = now.files[file]?.[kind] ?? 0;
      const allowed = listed.get(pairKey(file, kind)) ?? 0;
      if (truth > allowed) unlisted.push({ file, kind, truth, allowed });
      else if (truth < allowed) stale.push({ file, kind, truth, allowed });
    }
  }
  return { unlisted, stale };
}

export const gapLine = (g: AllowedGap) => `${g.file} — «${g.kind}»: المكتوب ${g.truth}، المسموح ${g.allowed}`;

/** What is wrong with the list itself: a short reason, a repeated pair, a kind that is not pinned to zero, a bad count. */
export function allowedProblems(allowed: readonly AllowedEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of allowed) {
    const id = `${e.file} — «${e.kind}»`;
    if (!(ZERO_KINDS as readonly string[]).includes(e.kind)) problems.push(`${id}: النوع مش من الأنواع اللي سقفها صفر`);
    if (!Number.isInteger(e.count) || e.count < 1) problems.push(`${id}: العدد لازم يكون عدداً صحيحاً أكبر من صفر`);
    if (e.file.includes('\\')) problems.push(`${id}: شرطة مائلة خاطئة`);
    if (e.why.trim().length < MIN_WHY || !/[\u0600-\u06FF]/.test(e.why)) problems.push(`${id}: السبب لازم يكون بالعربي وبـ ${MIN_WHY} حرفاً على الأقل`);
    if (seen.has(id)) problems.push(`${id}: مكرّر — سطر واحد لكل ملف ونوع`);
    seen.add(id);
  }
  return problems;
}

/** Everything that makes the list and the truth disagree, as printable lines. Empty = they agree. */
export function allowedReport(now: Registry): string[] {
  const gaps = allowedGaps(now);
  return [
    ...allowedProblems(now.allowed),
    ...gaps.unlisted.map((g) => `${gapLine(g)} — عنصر خام بلا إذن`),
    ...gaps.stale.map((g) => `${gapLine(g)} — إذن أكبر من الحقيقة`),
  ];
}

/** What is written by hand RIGHT NOW: each file's non-zero kinds, files with nothing left omitted. */
export function measure(): Registry {
  const files: Record<string, DebtRow> = {};
  for (const rel of uiFilePaths()) {
    if (!inDebtScope(rel)) continue;
    const counts = countsOf(readFileSync(join(ROOT, rel), 'utf8'));
    const row: DebtRow = {};
    for (const k of DEBT_KINDS) if (counts[k] > 0) row[k] = counts[k];
    if (Object.keys(row).length > 0) files[rel] = row;
  }
  return { files, allowed: [...ALLOWED].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)) };
}

/**
 * The registry's text, read. It holds exactly two keys: `files` (per-file rows) and `allowed` (R19, copied from `ALLOWED`).
 * Anything else (a `totals` block above all) is refused: the totals are added up, never stored.
 */
export function parseRegistry(text: string): Registry {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const extra = Object.keys(raw).filter((k) => k !== 'files' && k !== 'allowed');
  if (extra.length > 0 || typeof raw.files !== 'object' || raw.files === null || !Array.isArray(raw.allowed)) {
    throw new Error(
      `سجل الدَّين فيه مفتاح غير «files» و«allowed»: ${extra.join('، ') || '(files أو allowed ناقص)'} — المجاميع ما بتنحفظ، بتنحسب من الملفات. احذفه وشغّل: npx tsx scripts/ui-debt.ts --write`
    );
  }
  return { files: raw.files as Registry['files'], allowed: raw.allowed as AllowedEntry[] };
}

export function readRegistry(path = DEBT_PATH): Registry | null {
  return existsSync(path) ? parseRegistry(readFileSync(path, 'utf8')) : null;
}

/** The registry as it is written to disk — one canonical form, so a generated file is never touched by hand. */
export function render(reg: Registry): string {
  return `${JSON.stringify({ files: reg.files, allowed: reg.allowed }, null, 2)}\n`;
}

export interface Change {
  file: string;
  kind: DebtKind;
  pinned: number;
  now: number;
}

/** Every per-file, per-kind difference between the pinned registry and what is written now. A missing key is zero. */
export function compare(pinned: Registry, now: Registry): { rises: Change[]; falls: Change[] } {
  const rises: Change[] = [];
  const falls: Change[] = [];
  for (const file of [...new Set([...Object.keys(pinned.files), ...Object.keys(now.files)])].sort()) {
    for (const kind of DEBT_KINDS) {
      const before = pinned.files[file]?.[kind] ?? 0;
      const after = now.files[file]?.[kind] ?? 0;
      if (after > before) rises.push({ file, kind, pinned: before, now: after });
      else if (after < before) falls.push({ file, kind, pinned: before, now: after });
    }
  }
  return { rises, falls };
}

export const riseLine = (c: Change) => `${c.file} — «${c.kind}»: ${c.pinned} ← ${c.now}`;

// ───────────────────────── the commands ─────────────────────────

export interface Io {
  measure: () => Registry;
  read: () => Registry | null;
  write: (text: string) => void;
  source: (rel: string) => string | null;
}

export interface Result {
  code: number;
  out: string[];
  err: string[];
}

const realIo: Io = {
  measure,
  read: () => readRegistry(),
  write: (text) => writeFileSync(DEBT_PATH, text, 'utf8'),
  source: (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null),
};

export function explain(rel: string, source: string): string[] {
  const hits = hitsOf(source);
  const lines = [`${rel}`];
  const bare = hits.filter((h) => h.kind !== 'textXs');
  if (bare.length === 0 && !hits.length) lines.push('  لا شيء مكتوب باليد من هذه الأنواع.');
  for (const h of bare) lines.push(`  سطر ${h.line}  ${h.kind}  ${h.text}\n      ← ${h.use}`);
  const xs = hits.filter((h) => h.kind === 'textXs');
  if (xs.length) lines.push(`  textXs ×${xs.length} — أسطر: ${[...new Set(xs.map((h) => h.line))].join(', ')}`);
  return lines;
}

/** One entry point for the three commands, with its inputs and outputs passed in so a test can drive it without touching the disk. */
export function run(argv: string[], io: Io = realIo): Result {
  const out: string[] = [];
  const err: string[] = [];

  const at = argv.indexOf('--explain');
  if (at >= 0) {
    const rel = (argv[at + 1] ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    const source = rel ? io.source(rel) : null;
    if (source === null) {
      err.push(`لا ملف بهذا الاسم: «${rel}». اكتب المسار من جذر المشروع، مثل src/components/screens/OrdersScreen.tsx`);
      return { code: 1, out, err };
    }
    out.push(...explain(rel, source));
    return { code: 0, out, err };
  }

  const now = io.measure();
  let pinned: Registry | null;
  try {
    pinned = io.read();
  } catch (e) {
    err.push((e as Error).message);
    return { code: 1, out, err };
  }

  if (argv.includes('--write')) {
    if (pinned) {
      const { rises } = compare(pinned, now);
      if (rises.length > 0) {
        err.push(
          `ما بنثبّت رقماً أعلى — الدَّين بس بينزل. ارتفع:\n${rises.map((c) => `  ${riseLine(c)}`).join('\n')}\n` +
            'استعمل مكوّن العدّة بدل المكتوب باليد: npx tsx scripts/ui-debt.ts --explain <ملف>'
        );
        return { code: 1, out, err };
      }
    }
    const bad = allowedReport(now);
    if (bad.length > 0) {
      err.push(`القائمة المسموحة (ALLOWED في scripts/ui-debt.ts) ما بتطابق المكتوب — ما بنثبّت قبل ما تتصلّح:\n${bad.map((l) => `  ${l}`).join('\n')}`);
      return { code: 1, out, err };
    }
    io.write(render(now));
    out.push(`تم التثبيت: ${Object.keys(now.files).length} ملف`);
  }

  // After a `--write` the ceiling IS what was just measured; otherwise it is what is pinned.
  const ceilings = argv.includes('--write') ? now : (pinned ?? now);
  out.push(`${Object.keys(now.files).length} ملف فيه دَين`);
  const nowTotals = totalsOf(now);
  const ceilingTotals = totalsOf(ceilings);
  const sums = allowedSums(now.allowed);
  for (const k of DEBT_KINDS) {
    const zero = (ZERO_KINDS as readonly string[]).includes(k);
    out.push(`  ${k.padEnd(15)} ${String(nowTotals[k]).padStart(5)}   السقف ${String(ceilingTotals[k]).padStart(5)}${zero ? `   المسموح ${String(sums[k]).padStart(5)}` : '   (يهبط فقط)'}`);
  }

  if (!argv.includes('--write')) {
    if (!pinned) {
      err.push('ما في سجل مثبّت — شغّل: npx tsx scripts/ui-debt.ts --write');
      return { code: 1, out, err };
    }
    const { rises, falls } = compare(pinned, now);
    const bad = allowedReport(now);
    if (bad.length) err.push(`القائمة المسموحة ما بتطابق المكتوب:\n${bad.map((l) => `  ${l}`).join('\n')}`);
    if (rises.length) err.push(`ارتفع الدَّين:\n${rises.map((c) => `  ${riseLine(c)}`).join('\n')}`);
    if (falls.length) err.push(`نزل الدَّين ولم يُثبَّت — شغّل: npx tsx scripts/ui-debt.ts --write\n${falls.map((c) => `  ${riseLine(c)}`).join('\n')}`);
    if (rises.length || falls.length || bad.length) return { code: 1, out, err };
  }
  return { code: 0, out, err };
}

if (basename(process.argv[1] ?? '').replace(/\.[cm]?[jt]s$/, '') === 'ui-debt') {
  const result = run(process.argv.slice(2));
  for (const l of result.out) console.log(l);
  for (const l of result.err) console.error(l);
  process.exit(result.code);
}
