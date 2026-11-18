/**
 * THE DEBT COUNTER — A NUMBER PER FILE AND PER KIND THAT CAN ONLY GO DOWN.
 *
 * The restructure moves every screen onto one kit, one screen at a time, by hand. What it must never do is move
 * BACKWARDS while it does: a button written raw because the kit one was a click away, a card drawn from the card colour
 * because copying a line is quicker than importing a component. So what is still written by hand is counted, here, per
 * file and per kind, and the number is pinned in `scripts/ui-debt.json`.
 *
 *   npx tsx scripts/ui-debt.ts                  # prints the totals against the pinned ceilings
 *   npx tsx scripts/ui-debt.ts --write          # pins a LOWER number; REFUSES any file that rose
 *   npx tsx scripts/ui-debt.ts --explain <file> # every raw control in the file, its line, and the kit part that replaces it
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

export interface Registry {
  totals: DebtCounts;
  files: Record<string, DebtRow>;
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

// ───────────────────────── the registry ─────────────────────────

/** A file is in the debt's scope when the census walks it and it is neither the kit nor the seller's own. */
export function inDebtScope(rel: string): boolean {
  const p = `/${rel}`;
  if (p.includes('/components/ui/')) return false;
  return !SELLER_SURFACES.some((s) => p.includes(s));
}

const sumOf = (files: Record<string, DebtRow>): DebtCounts => {
  const totals = Object.fromEntries(DEBT_KINDS.map((k) => [k, 0])) as DebtCounts;
  for (const row of Object.values(files)) for (const k of DEBT_KINDS) totals[k] += row[k] ?? 0;
  return totals;
};

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
  return { totals: sumOf(files), files };
}

export function readRegistry(path = DEBT_PATH): Registry | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Registry) : null;
}

/** The registry as it is written to disk — one canonical form, so a generated file is never touched by hand. */
export function render(reg: Registry): string {
  return `${JSON.stringify({ totals: reg.totals, files: reg.files }, null, 2)}\n`;
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
  const pinned = io.read();

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
    io.write(render(now));
    out.push(`تم التثبيت: ${Object.keys(now.files).length} ملف`);
  }

  // After a `--write` the ceiling IS what was just measured; otherwise it is what is pinned.
  const ceilings = argv.includes('--write') ? now : (pinned ?? now);
  out.push(`${Object.keys(now.files).length} ملف فيه دَين`);
  for (const k of DEBT_KINDS) out.push(`  ${k.padEnd(15)} ${String(now.totals[k]).padStart(5)}   السقف ${String(ceilings.totals[k]).padStart(5)}`);

  if (!argv.includes('--write')) {
    if (!pinned) {
      err.push('ما في سجل مثبّت — شغّل: npx tsx scripts/ui-debt.ts --write');
      return { code: 1, out, err };
    }
    const { rises, falls } = compare(pinned, now);
    if (rises.length) err.push(`ارتفع الدَّين:\n${rises.map((c) => `  ${riseLine(c)}`).join('\n')}`);
    if (falls.length) err.push(`نزل الدَّين ولم يُثبَّت — شغّل: npx tsx scripts/ui-debt.ts --write\n${falls.map((c) => `  ${riseLine(c)}`).join('\n')}`);
    if (rises.length || falls.length) return { code: 1, out, err };
  }
  return { code: 0, out, err };
}

if (basename(process.argv[1] ?? '').replace(/\.[cm]?[jt]s$/, '') === 'ui-debt') {
  const result = run(process.argv.slice(2));
  for (const l of result.out) console.log(l);
  for (const l of result.err) console.error(l);
  process.exit(result.code);
}
