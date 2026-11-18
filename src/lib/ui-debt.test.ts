import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEBT_KINDS,
  compare,
  countsOf,
  explain,
  hitsOf,
  inDebtScope,
  measure,
  render,
  riseLine,
  run,
  type Io,
  type Registry,
} from '../../scripts/ui-debt';

/**
 * THE DEBT THAT CAN ONLY GO DOWN (18/11, R0 of the restructure).
 *
 * Everything still written by hand — a raw `<button>`, a card drawn from the card colour, a `<ScreenTitle`, a `text-xs`, a hand
 * made date box — is counted per file and per kind by `scripts/ui-debt.ts` and pinned in `scripts/ui-debt.json`. The restructure
 * moves screens onto the kit one at a time; this is what stops it moving backwards between two of them.
 *
 *   · a number that ROSE fails, naming the file and the kind;
 *   · a number that FELL and was not pinned fails too: otherwise the ceiling is higher than the truth, and the next rise
 *     hides underneath it;
 *   · `npx tsx scripts/ui-debt.ts --write` pins the lower number, and REFUSES (exit 1, writes nothing) if any file rose.
 *
 * The registry file is generated. It is never edited by hand: a hand edit that raised a ceiling would be the whole point of
 * this guard defeated by one keystroke, so the totals are re-added from the files below.
 */

const pinned: Registry = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'ui-debt.json'), 'utf8'));
const now = measure();

describe('the pinned debt against what is written now', () => {
  it.each(DEBT_KINDS)('«%s» has not risen in any file', (kind) => {
    const rises = compare(pinned, now).rises.filter((c) => c.kind === kind);
    expect(
      rises.map(riseLine),
      `ارتفع «${kind}» — الدَّين ما بيطلع. استعمل مكوّن العدّة بدل المكتوب باليد، والتقرير: npx tsx scripts/ui-debt.ts --explain <ملف>`
    ).toEqual([]);
  });

  it.each(DEBT_KINDS)('«%s» has not fallen without being pinned', (kind) => {
    const falls = compare(pinned, now).falls.filter((c) => c.kind === kind);
    expect(
      falls.map(riseLine),
      `نزل «${kind}» ولم يُثبَّت — شغّل npx tsx scripts/ui-debt.ts --write في نفس الكوميت حتى يصير الرقم الأقل هو السقف`
    ).toEqual([]);
  });

  it('keeps its totals equal to the sum of its files — a hand-edited ceiling shows here', () => {
    for (const kind of DEBT_KINDS) {
      const sum = Object.values(pinned.files).reduce((s, row) => s + (row[kind] ?? 0), 0);
      expect(pinned.totals[kind], `مجموع «${kind}» في السجل لا يساوي مجموع ملفاته — السجل يُولَّد ولا يُعدَّل باليد`).toBe(sum);
    }
  });

  it('is exactly what the script writes — byte for byte', () => {
    expect(render(now), 'السجل المثبّت يختلف عن مخرجات --write').toBe(readFileSync(join(process.cwd(), 'scripts', 'ui-debt.json'), 'utf8').replace(/\r\n/g, '\n'));
  });

  it('names real files, with forward slashes, in the scope, with a count above zero', () => {
    for (const [file, row] of Object.entries(pinned.files)) {
      expect(file.includes('\\'), `${file}: شرطة مائلة خاطئة`).toBe(false);
      expect(existsSync(join(process.cwd(), file)), `${file}: لا ملف بهذا المسار`).toBe(true);
      expect(inDebtScope(file), `${file}: خارج نطاق العدّاد`).toBe(true);
      expect(Object.keys(row).length, `${file}: صف بلا دَين — يُحذف`).toBeGreaterThan(0);
      for (const [kind, n] of Object.entries(row)) {
        expect((DEBT_KINDS as readonly string[]).includes(kind), `${file}: نوع مجهول ${kind}`).toBe(true);
        expect(Number.isInteger(n) && (n as number) > 0, `${file}.${kind}`).toBe(true);
      }
    }
  });

  it('sees the screens, not an empty list', () => {
    expect(Object.keys(now.files).length).toBeGreaterThan(100);
    for (const kind of DEBT_KINDS) expect(now.totals[kind], `«${kind}» لا يُعدّ إطلاقاً`).toBeGreaterThan(0);
  });

  it('leaves the kit alone: a raw button inside src/components/ui is the kit itself', () => {
    expect(inDebtScope('src/components/ui/Button.tsx')).toBe(false);
    expect(inDebtScope('src/components/screens/OrdersScreen.tsx')).toBe(true);
    expect(Object.keys(now.files).filter((f) => f.startsWith('src/components/ui/'))).toEqual([]);
  });

  it('leaves the seller’s own surfaces alone — a shop is the seller’s design', () => {
    for (const f of ['src/components/storefront/X.tsx', 'src/components/landing/X.tsx', 'src/app/s/[store]/page.tsx', 'src/app/lp/[slug]/page.tsx']) {
      expect(inDebtScope(f), f).toBe(false);
    }
  });
});

describe('a raw button added to a panel file is refused, by file and by kind', () => {
  it('the real registry, one raw button more in one real file: the comparison names both', () => {
    const file = Object.keys(pinned.files).find((f) => (pinned.files[f].rawButtons ?? 0) > 0)!;
    const worse: Registry = JSON.parse(JSON.stringify(pinned));
    worse.files[file].rawButtons = (worse.files[file].rawButtons ?? 0) + 1;
    const { rises } = compare(pinned, worse);
    expect(rises).toHaveLength(1);
    expect(riseLine(rises[0])).toContain(file);
    expect(riseLine(rises[0])).toContain('rawButtons');
  });

  it('a NEW file with a raw button is a rise from zero, not a free start', () => {
    const worse: Registry = JSON.parse(JSON.stringify(pinned));
    worse.files['src/components/screens/BrandNewScreen.tsx'] = { rawButtons: 1 };
    expect(compare(pinned, worse).rises.map(riseLine)).toEqual(['src/components/screens/BrandNewScreen.tsx — «rawButtons»: 0 ← 1']);
  });

  it('a file that stops being debt is a fall that has to be pinned', () => {
    const better: Registry = JSON.parse(JSON.stringify(pinned));
    const file = Object.keys(better.files)[0];
    delete better.files[file];
    const { rises, falls } = compare(pinned, better);
    expect(rises).toEqual([]);
    expect(falls.length).toBeGreaterThan(0);
    expect(falls.every((c) => c.file === file && c.now === 0)).toBe(true);
  });
});

// ───────────────────────── the counters ─────────────────────────

const c = (src: string) => countsOf(src);

describe('what the counter counts', () => {
  it('a raw `<button` is debt and the kit’s `<Button` is not', () => {
    expect(c('<button onClick={a}>x</button><Button>y</Button><ButtonGroup/>').rawButtons).toBe(1);
  });

  it('a sentence that names a tag is not a tag — comments are blanked', () => {
    expect(c('// <button> is raw\n/* a <button> and text-xs <ScreenTitle */\n<div/>')).toEqual({
      rawButtons: 0, rawCheckboxes: 0, rawSurfaces: 0, rawDatePickers: 0, screenTitle: 0, textXs: 0,
    });
  });

  it('counts a tag whose attributes carry an arrow function and span lines', () => {
    const src = '<input\n  type="checkbox"\n  checked={on}\n  onChange={(e) => setOn(e.target.checked)}\n/>';
    expect(c(src).rawCheckboxes).toBe(1);
  });

  it('tells a checkbox from a date box from a text box', () => {
    expect(c('<input type="checkbox" />').rawCheckboxes).toBe(1);
    expect(c('<input type="date" />').rawDatePickers).toBe(1);
    expect(c('<input type="datetime-local" />').rawDatePickers).toBe(1);
    expect(c('<input type="month" />').rawDatePickers).toBe(1);
    expect(c('<input type="text" /><input type="number" /><input type="radio" />')).toMatchObject({ rawCheckboxes: 0, rawDatePickers: 0 });
  });

  it('counts a ScreenTitle use and every text-xs, however it is prefixed, but not a longer word', () => {
    expect(c('<ScreenTitle title="x" /><PageHeader/>').screenTitle).toBe(1);
    expect(c('<p className="text-xs md:text-xs text-xsm context-text-xs">').textXs).toBe(2);
  });

  it('counts a card drawn by hand: the card fill, a border and the surface corner', () => {
    expect(c('<div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">').rawSurfaces).toBe(1);
    expect(c('<ul className={`bg-[var(--sys-surface)] border rounded-lg ${x}`}>').rawSurfaces).toBe(1);
  });

  it('but not a field wearing the same fill, a chip, a fill with no edge, or a smaller corner', () => {
    expect(c('<input className="rounded-lg border bg-[var(--sys-card)] px-3 py-2" />').rawSurfaces).toBe(0);
    expect(c('<div className="rounded-lg border bg-[var(--sys-card)] outline-none focus:border-x">').rawSurfaces).toBe(0);
    expect(c('<select\n className="rounded-lg border bg-[var(--sys-card)] px-2"\n/>').rawSurfaces).toBe(0);
    expect(c('<div className="rounded-lg bg-[var(--sys-card)] p-4">').rawSurfaces).toBe(0);
    expect(c('<div className="rounded-md border bg-[var(--sys-card)] p-4">').rawSurfaces).toBe(0);
    expect(c('<div className="rounded-lg border p-4">').rawSurfaces).toBe(0);
  });

  it('counts one surface once, however many fills the class string repeats', () => {
    expect(c('<div className="rounded-lg border bg-[var(--sys-card)] hover:bg-[var(--sys-surface)]">').rawSurfaces).toBe(1);
  });

  it('reads a CRLF file and an LF file as the same number', () => {
    const lf = '<button>a</button>\n<input\n type="checkbox"\n/>\n<p className="text-xs">\n<ScreenTitle/>\n';
    expect(c(lf.replace(/\n/g, '\r\n'))).toEqual(c(lf));
  });

  it('explains a line with the kit part that replaces it', () => {
    const lines = explain('x.tsx', '<div>\n<button aria-label="إغلاق" onClick={a}><RiCloseLine/></button>\n<input type="checkbox"/>\n</div>');
    const text = lines.join('\n');
    expect(text).toContain('سطر 2');
    expect(text).toContain('IconButton');
    expect(text).toContain('سطر 3');
    expect(text).toContain('Checkbox');
    expect(hitsOf('<button className="rounded-lg border">x</button>')[0].use).toContain('secondary');
  });
});

// ───────────────────────── the commands ─────────────────────────

const reg = (files: Registry['files']): Registry => {
  const totals = Object.fromEntries(DEBT_KINDS.map((k) => [k, 0])) as Registry['totals'];
  for (const row of Object.values(files)) for (const k of DEBT_KINDS) totals[k] += row[k] ?? 0;
  return { totals, files };
};

function io(pinnedReg: Registry | null, nowReg: Registry) {
  const written: string[] = [];
  const fake: Io = { measure: () => nowReg, read: () => pinnedReg, write: (t) => written.push(t), source: () => null };
  return { fake, written };
}

describe('`--write` pins a lower number and never a higher one', () => {
  it('REFUSES a file that rose: exit 1, says which, writes nothing', () => {
    const { fake, written } = io(reg({ 'a.tsx': { rawButtons: 2 }, 'b.tsx': { rawButtons: 5 } }), reg({ 'a.tsx': { rawButtons: 3 }, 'b.tsx': { rawButtons: 1 } }));
    const r = run(['--write'], fake);
    expect(r.code).toBe(1);
    expect(written).toEqual([]);
    expect(r.err.join('\n')).toContain('a.tsx — «rawButtons»: 2 ← 3');
  });

  it('REFUSES even when another file fell by more — a total that stayed level hides nothing', () => {
    const { fake, written } = io(reg({ 'a.tsx': { rawButtons: 2 }, 'b.tsx': { rawButtons: 9 } }), reg({ 'a.tsx': { rawButtons: 3 }, 'b.tsx': { rawButtons: 1 } }));
    expect(run(['--write'], fake).code).toBe(1);
    expect(written).toEqual([]);
  });

  it('REFUSES a new file that arrives with debt', () => {
    const { fake, written } = io(reg({ 'a.tsx': { rawButtons: 2 } }), reg({ 'a.tsx': { rawButtons: 2 }, 'new.tsx': { textXs: 1 } }));
    expect(run(['--write'], fake).code).toBe(1);
    expect(written).toEqual([]);
  });

  it('REFUSES a kind that rose where another fell in the same file', () => {
    const { fake } = io(reg({ 'a.tsx': { rawButtons: 4, textXs: 1 } }), reg({ 'a.tsx': { rawButtons: 1, textXs: 2 } }));
    expect(run(['--write'], fake).code).toBe(1);
  });

  it('pins a fall: exit 0 and the new, lower registry is what is written', () => {
    const lower = reg({ 'a.tsx': { rawButtons: 1 } });
    const { fake, written } = io(reg({ 'a.tsx': { rawButtons: 2 }, 'gone.tsx': { textXs: 3 } }), lower);
    expect(run(['--write'], fake).code).toBe(0);
    expect(written).toEqual([render(lower)]);
  });

  it('writes the first registry when there is none yet', () => {
    const first = reg({ 'a.tsx': { rawButtons: 2 } });
    const { fake, written } = io(null, first);
    expect(run(['--write'], fake).code).toBe(0);
    expect(written).toEqual([render(first)]);
  });
});

describe('the plain run prints the totals against the ceilings', () => {
  it('exit 0 when they are equal, and the ceiling is printed beside the number', () => {
    const same = reg({ 'a.tsx': { rawButtons: 2, textXs: 7 } });
    const r = run([], io(same, same).fake);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/rawButtons\s+2\s+السقف\s+2/);
    expect(r.out.join('\n')).toMatch(/textXs\s+7\s+السقف\s+7/);
  });

  it('exit 1 on a rise, naming file and kind', () => {
    const r = run([], io(reg({ 'a.tsx': { rawButtons: 2 } }), reg({ 'a.tsx': { rawButtons: 3 } })).fake);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('a.tsx — «rawButtons»');
  });

  it('exit 1 on a fall nobody pinned, and says to run --write', () => {
    const r = run([], io(reg({ 'a.tsx': { rawButtons: 2 } }), reg({ 'a.tsx': { rawButtons: 1 } })).fake);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('--write');
  });

  it('`--explain` takes a Windows path and says plainly when the file is not there', () => {
    const asked: string[] = [];
    const fake: Io = { measure: () => reg({}), read: () => null, write: () => {}, source: (rel) => (asked.push(rel), rel === 'x/y.tsx' ? '<button>a</button>' : null) };
    expect(run(['--explain', '.\\x\\y.tsx'], fake).code).toBe(0);
    expect(asked).toEqual(['x/y.tsx']);
    const missing = run(['--explain', 'nope.tsx'], fake);
    expect(missing.code).toBe(1);
    expect(missing.err.join('\n')).toContain('nope.tsx');
  });
});
