import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED,
  DEBT_KINDS,
  MIN_WHY,
  ZERO_KINDS,
  allowedGaps,
  allowedProblems,
  allowedSums,
  allowedReport,
  compare,
  countsOf,
  explain,
  hitsOf,
  inDebtScope,
  measure,
  parseRegistry,
  render,
  riseLine,
  run,
  totalsOf,
  gapLine,
  type AllowedEntry,
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
 * this guard defeated by one keystroke — the byte-for-byte check below catches it.
 *
 * 18/11: the registry no longer stores a `totals` block (every screen PR changed those lines, so any two PRs conflicted on
 * the file). The totals are computed from the per-file rows (`totalsOf`) wherever they are needed, and a registry that
 * carries a `totals` key again is refused.
 *
 * 19/11 (R19c): the registry gained ONE more key, `allowed` — the list of raw controls that are right to stay raw, each with a
 * sentence in plain Arabic. It is WRITTEN in `scripts/ui-debt.ts` (`ALLOWED`) and copied to the JSON by `--write`; the JSON is
 * never its source. Five kinds are pinned to ZERO outside it (the last describes of this file); `textXs` keeps «only falls». The old test «keeps its totals equal to the sum of its files» guarded a stored
 * number that no longer exists; its intent (no hand-edited ceiling) is held by the byte check and by the refusal test.
 */

const pinned: Registry = parseRegistry(readFileSync(join(process.cwd(), 'scripts', 'ui-debt.json'), 'utf8'));
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

  it('holds per-file rows only — a stored totals block is refused, so it never comes back', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'ui-debt.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw), 'السجل بيحمل «files» و«allowed» بس — المجاميع بتنحسب').toEqual(['files', 'allowed']);
    const withTotals = JSON.stringify({ totals: totalsOf(pinned), files: pinned.files, allowed: pinned.allowed });
    expect(() => parseRegistry(withTotals)).toThrow(/totals/);
    expect(() => parseRegistry(JSON.stringify({ files: {}, allowed: [], other: 1 }))).toThrow(/other/);
    expect(() => parseRegistry(JSON.stringify({ files: {} }))).toThrow(/allowed/);
    expect(() => parseRegistry(JSON.stringify({ totals: {} }))).toThrow();
    expect(parseRegistry(JSON.stringify({ files: { 'a.tsx': { rawButtons: 1 } }, allowed: [] }))).toEqual({ files: { 'a.tsx': { rawButtons: 1 } }, allowed: [] });
  });

  it('the plain run and --write both refuse a registry carrying totals, and write nothing', () => {
    const written: string[] = [];
    const fake: Io = {
      measure: () => now,
      read: () => parseRegistry(JSON.stringify({ totals: totalsOf(now), files: now.files, allowed: now.allowed })),
      write: (t) => written.push(t),
      source: () => null,
    };
    for (const argv of [[], ['--write']]) {
      const r = run(argv, fake);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.join('\n')).toContain('totals');
    }
    expect(written).toEqual([]);
  });

  it('adds its totals up from the files', () => {
    expect(totalsOf({ files: { 'a.tsx': { rawButtons: 2, textXs: 1 }, 'b.tsx': { rawButtons: 3 } }, allowed: [] })).toEqual({
      rawButtons: 5, rawCheckboxes: 0, rawSurfaces: 0, rawDatePickers: 0, screenTitle: 0, textXs: 1,
    });
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
    // 18/11 (R3): was «every kind above zero». `screenTitle` is PAID — the component is deleted and its 27 uses draw PageHeader —
    // so it stays a kind (a reintroduction fails the per-file pin) at 0 everywhere; the unit test below proves it is still counted.
    const totals = totalsOf(now);
    for (const kind of DEBT_KINDS.filter((k) => k !== 'screenTitle')) expect(totals[kind], `«${kind}» لا يُعدّ إطلاقاً`).toBeGreaterThan(0);
    expect(totals.screenTitle, 'رجع ScreenTitle').toBe(0);
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
    // Written in pieces: Tailwind reads tests too, and a whole `md:` + size token here would ship a real rule in every page's sheet.
    const xs = ['text', 'xs'].join('-');
    expect(c(`<p className="${xs} md:${xs} ${xs}m context-${xs}">`).textXs).toBe(2);
  });

  it('counts a card drawn by hand: the card fill, a border and the surface corner', () => {
    expect(c('<div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">').rawSurfaces).toBe(1);
    expect(c('<ul className={`bg-[var(--sys-surface)] border rounded-lg ${x}`}>').rawSurfaces).toBe(1);
  });

  it('but not a field wearing the same fill, a chip, a fill with no edge, or a smaller corner', () => {
    expect(c('<input className="rounded-lg border bg-[var(--sys-card)] px-3 py-2" />').rawSurfaces).toBe(0);
    expect(c('<div className="rounded-lg border bg-[var(--sys-card)] outline-none">').rawSurfaces).toBe(0);
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

/** A registry whose allowed list says exactly what is written (the five zero kinds), so a command test starts from agreement. */
const reg = (files: Registry['files']): Registry => ({
  files,
  allowed: Object.entries(files).flatMap(([file, row]) =>
    ZERO_KINDS.filter((kind) => (row[kind] ?? 0) > 0).map((kind) => ({ file, kind, count: row[kind] as number, why: 'سبب مكتوب بالعربي للاختبار فقط' }))
  ),
});

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

// ───────────────────────── R19c: zero outside the allowed list ─────────────────────────

/**
 * R19c (19/11). Five of the six kinds are pinned to ZERO outside `ALLOWED` (scripts/ui-debt.ts): a raw button, a raw checkbox, a hand
 * drawn surface, a raw date box and a `<ScreenTitle` are all either in the list — with a sentence saying why it stays raw — or a
 * failure naming the file. A list count above what is written is a stale entry and fails too, so the list can only shrink with the
 * truth. `textXs` is NOT here: a caption is `text-note`, but some `text-xs` are legitimate small labels, so it keeps «only falls».
 */
const gaps = allowedGaps(now);

describe('zero outside the allowed list — the five kinds', () => {
  it.each(ZERO_KINDS)('«%s»: no file writes more than the list allows', (kind) => {
    expect(
      gaps.unlisted.filter((g) => g.kind === kind).map(gapLine),
      `في ملف كتب «${kind}» بلا إذن. استعمل مكوّن العدّة (npx tsx scripts/ui-debt.ts --explain <ملف>)، أو لو العنصر الخام صح فعلاً أضف سطراً بسبب بالعربي في ALLOWED داخل scripts/ui-debt.ts`
    ).toEqual([]);
  });

  it.each(ZERO_KINDS)('«%s»: no allowed count is above the truth (a stale entry)', (kind) => {
    expect(
      gaps.stale.filter((g) => g.kind === kind).map(gapLine),
      `إذن بلا عنصر خلفه — نزّل العدد أو احذف السطر من ALLOWED داخل scripts/ui-debt.ts، وبعدها npx tsx scripts/ui-debt.ts --write`
    ).toEqual([]);
  });

  it('nothing is outside the list, so its sums equal the totals', () => {
    const sums = allowedSums(ALLOWED);
    const totals = totalsOf(now);
    for (const kind of ZERO_KINDS) expect(sums[kind], kind).toBe(totals[kind]);
    expect(allowedReport(now)).toEqual([]);
  });

  it('every entry is well formed: a real file, a pinned kind, a count, a plain-Arabic sentence, one line per file and kind', () => {
    expect(allowedProblems(ALLOWED)).toEqual([]);
    for (const e of ALLOWED) {
      expect(existsSync(join(process.cwd(), e.file)), `${e.file}: لا ملف بهذا المسار`).toBe(true);
      expect(inDebtScope(e.file), `${e.file}: خارج نطاق العدّاد`).toBe(true);
      expect(e.why.trim().length, `${e.file}: السبب أقصر من ${MIN_WHY}`).toBeGreaterThanOrEqual(MIN_WHY);
    }
    expect(ALLOWED.length).toBeGreaterThan(100);
  });

  it('the JSON copy of the list is the list in the script — it is generated, never the source', () => {
    expect(pinned.allowed).toEqual(now.allowed);
  });

  it('«textXs» stays out of the list: it keeps «only falls»', () => {
    expect([...ZERO_KINDS], 'الأنواع الخمسة بسقف صفر، وتحديداً هي').toEqual(['rawButtons', 'rawCheckboxes', 'rawSurfaces', 'rawDatePickers', 'screenTitle']);
    expect((ZERO_KINDS as readonly string[]).includes('textXs')).toBe(false);
    const withXs = [{ file: 'src/components/screens/OrdersScreen.tsx', kind: 'textXs', count: 1, why: 'سبب كافي بالعربي طويل بما يكفي' }] as unknown as AllowedEntry[];
    expect(allowedProblems(withXs).join('\n')).toContain('textXs');
    expect(totalsOf(now).textXs).toBeGreaterThan(0);
  });

  it('the storefront owner’s files are in the list with the owner’s sentence, and only they', () => {
    const owner = ALLOWED.filter((e) => e.why.startsWith('ملف صاحب المتجر لحد R18'));
    expect(owner.length).toBeGreaterThan(10);
    for (const e of owner) {
      expect(/landing-editor|landing-flow|Store[A-Za-z]*Screen|LandingPage[A-Za-z]*Screen|LandingLibraryScreen|store-admin/.test(e.file), e.file).toBe(true);
    }
  });
});

describe('the zero is real: an edit that breaks it is refused, naming the file', () => {
  /** Real source of one real screen, then ONE raw button more — the exact edit the guard exists to catch. */
  const screen = 'src/components/screens/OrdersScreen.tsx';
  const source = readFileSync(join(process.cwd(), screen), 'utf8');

  it('the screen is clean today, so the tests below start from agreement', () => {
    expect(now.files[screen]?.rawButtons ?? 0).toBe(0);
    expect(ALLOWED.some((e) => e.file === screen)).toBe(false);
  });

  it('one raw button added to that screen: the count rises by one and the comparison names the file and the kind', () => {
    const worse = countsOf(source + '\n<button onClick={go}>x</button>');
    expect(worse.rawButtons).toBe(countsOf(source).rawButtons + 1);
    const planted: Registry = { files: { ...now.files, [screen]: { ...now.files[screen], rawButtons: worse.rawButtons } }, allowed: now.allowed };
    expect(allowedGaps(planted).unlisted.map(gapLine)).toEqual([`${screen} — «rawButtons»: المكتوب ${worse.rawButtons}، المسموح 0`]);
    expect(allowedReport(planted).join('\n')).toContain(screen);
  });

  it('the plain run and --write both refuse it and write nothing', () => {
    const planted: Registry = { files: { ...now.files, [screen]: { rawButtons: 1 } }, allowed: now.allowed };
    const written: string[] = [];
    const fake: Io = { measure: () => planted, read: () => ({ files: planted.files, allowed: planted.allowed }), write: (t) => written.push(t), source: () => null };
    for (const argv of [[], ['--write']]) {
      const r = run(argv, fake);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.join('\n'), argv.join(' ')).toContain(screen);
    }
    expect(written).toEqual([]);
  });

  it('a new raw checkbox, hand-drawn surface, raw date box or ScreenTitle is refused the same way', () => {
    for (const kind of ZERO_KINDS) {
      const planted: Registry = { files: { ...now.files, [screen]: { [kind]: 1 } }, allowed: now.allowed };
      expect(allowedGaps(planted).unlisted.map((g) => `${g.file}|${g.kind}`), kind).toEqual([`${screen}|${kind}`]);
    }
  });

  it('an allowed count above the truth fails as a stale entry, naming the file', () => {
    const entry = ALLOWED[0];
    const inflated: Registry = { files: now.files, allowed: now.allowed.map((e) => (e.file === entry.file && e.kind === entry.kind ? { ...e, count: e.count + 1 } : e)) };
    const g = allowedGaps(inflated);
    expect(g.unlisted).toEqual([]);
    expect(g.stale.map(gapLine)).toEqual([`${entry.file} — «${entry.kind}»: المكتوب ${entry.count}، المسموح ${entry.count + 1}`]);
    expect(allowedReport(inflated).join('\n')).toContain('إذن أكبر من الحقيقة');
  });

  it('an entry for a file that no longer has the control is stale too', () => {
    const ghost: AllowedEntry = { file: screen, kind: 'rawButtons', count: 1, why: 'سبب كافي بالعربي طويل بما يكفي' };
    const g = allowedGaps({ files: now.files, allowed: [...now.allowed, ghost] });
    expect(g.stale.map((x) => x.file)).toEqual([ghost.file]);
  });

  it('a short or English reason is refused, and so is a repeated file and kind, and a zero count', () => {
    const e = (why: string): AllowedEntry => ({ file: 'a.tsx', kind: 'rawButtons', count: 1, why });
    expect(allowedProblems([e('قصير')]).join('')).toContain('بالعربي');
    expect(allowedProblems([e('this reason is long enough but not arabic at all')]).join('')).toContain('بالعربي');
    expect(allowedProblems([e('سبب عربي طويل بما يكفي تماماً'), e('سبب عربي ثانٍ طويل بما يكفي')]).join('')).toContain('مكرّر');
    expect(allowedProblems([{ ...e('سبب عربي طويل بما يكفي تماماً'), count: 0 }]).join('')).toContain('العدد');
  });

  it('the plain run prints the allowed sums beside the totals', () => {
    const r = run([], { measure: () => now, read: () => pinned, write: () => {}, source: () => null });
    expect(r.code).toBe(0);
    for (const kind of ZERO_KINDS) {
      expect(r.out.join('\n')).toMatch(new RegExp(`${kind}\\s+${totalsOf(now)[kind]}\\s+السقف\\s+${totalsOf(pinned)[kind]}\\s+المسموح\\s+${allowedSums(now.allowed)[kind]}\\b`));
    }
  });
});
