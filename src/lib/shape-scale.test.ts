import { describe, expect, it } from 'vitest';
import { dashboardFiles, stripComments } from './guard-source';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ONE SET OF CORNERS.
 *
 * Eight different corner radii were in use across the dashboard, and the
 * reason is the ordinary one: nobody chose eight, each screen chose one.
 * The result reads as slightly broken rather than as a style — a card at
 * 12px beside a panel at 8px beside a button at 6px, on the same row, and
 * the eye notices without being able to say what is wrong.
 *
 * So there are three, and they mean something:
 *
 *   sm (4px)    something inside a cell — a chip, a tiny field
 *   md (6px)    a control you press or type into
 *   lg (8px)    a surface: a card, a panel, a dialog
 *   full        a pill or an avatar, which is not a size
 *
 * These are Tailwind's own sm/md/lg, unchanged, so naming them moved no
 * pixels at all for the 515 places that were already writing 8px or 6px by
 * hand. What moved is the 179 places that were 12px or 16px, and moving
 * them is the whole point.
 *
 * A STORE'S OWN PAGES ARE NOT IN THIS. A landing page and a storefront are
 * the seller's design, and a dashboard rule that reached them would be the
 * same mistake as a dashboard colour reaching them.
 */

const SKIP = [
  '/components/landing/',
  '/components/public/',
  '/components/store/',
  '/app/(public)/',
  '/app/lp/',
  '/app/s/',
];

function systemFiles(): { path: string; rel: string; src: string }[] {
  const out: { path: string; rel: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if ((p.endsWith('.tsx') || p.endsWith('.ts')) && !p.includes('.test.')) {
        const rel = `/${relative(process.cwd(), p).split('\\').join('/')}`;
        if (!SKIP.some((s) => rel.includes(s))) out.push({ path: p, rel, src: readFileSync(p, 'utf8') });
      }
    }
  };
  walk(join(process.cwd(), 'src', 'components'));
  walk(join(process.cwd(), 'src', 'app'));
  return out;
}

// The leading guard matters: without it this finds the "rounded" inside
// "backgrounded" and "Grounded on real data", and reports a screen for a
// corner that is a word in a sentence.
/**
 * Source with its comments removed.
 *
 * These guards look for utility classes, and a comment explaining why a
 * class is forbidden contains that class. Reading the prose reports the
 * prose — the guard's own documentation becomes its first offender.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Any `rounded-*`, not a list of the ones that existed when this was
 * written. The list was the hole: a `rounded-sheet` — a token added in good
 * faith, as a fourth surface step for one dialog — matched nothing here and
 * so was reported as nothing. A guard that only knows the steps it already
 * approves of cannot catch a new one being invented.
 */
const RADIUS = /(?<![\w-])rounded(?:-[tbrlse]{1,2})?(?:-(\[[^\]]+\]|[a-z0-9]+))?(?![\w-])/g;

/** A bare `rounded` is Tailwind's 4px, and a step nobody chose. */
const BARE = 'bare';

/** The four that mean something, plus `none`, which is a deliberate square. */
const ALLOWED = new Set(['sm', 'md', 'lg', 'full', 'none']);

describe('the corners of the dashboard', () => {
  it('are drawn from the scale, never measured in pixels by hand', () => {
    const offenders: string[] = [];
    for (const { rel, src } of systemFiles()) {
      for (const m of code(src).matchAll(RADIUS)) {
        if ((m[1] ?? BARE).startsWith('[')) offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders, `زاوية مقاسة باليد بدل السلّم:\n${offenders.slice(0, 20).join('\n')}`).toEqual([]);
  });

  it('and use no step outside it', () => {
    const offenders: string[] = [];
    for (const { rel, src } of systemFiles()) {
      for (const m of code(src).matchAll(RADIUS)) {
        if (!ALLOWED.has(m[1] ?? BARE)) offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders, `درجة خارج السلّم:\n${offenders.slice(0, 20).join('\n')}`).toEqual([]);
  });

  it('so every surface in the system has the SAME corner', () => {
    // The property the whole exercise is for, stated as a number: one
    // radius does the surfaces, and it is the common one.
    const { top, share } = largeShare(cornerCounts(systemFiles()));
    expect(top).toBe('lg');
    expect(share, 'الأسطح لم تعد على زاوية واحدة').toBeGreaterThan(0.9);
  });

  /*
   * 18/11 — THE KIT IS COUNTED WHERE IT IS USED.
   *
   * Before: the share above counted only the corner words written in source.
   * A card moved onto the kit's Card (or a press onto the kit's Button) stops
   * writing its corner — the kit writes it once, inside its own file — so
   * every move onto the kit LOWERED the share although every surface still
   * wore the same corner (main stood at about 0.899 against the 0.9 floor).
   * After: each use of a kit piece that draws the large corner counts as one
   * large corner at the call site, unless the call site names a corner of its
   * own (that word is already counted as written). The floor stays 0.9 and
   * nothing is excused; the pins below keep the counting honest.
   */
  it('counts a kit surface at its call site, so moving onto the kit keeps the share', () => {
    const imp = "import { Card } from '@/components/ui/Card';\n";
    const before = cornerCounts([
      { rel: '/x.tsx', src: `const a = <div className="rounded-lg border p-4">x</div>; const b = <div className="rounded-md">y</div>;` },
    ]);
    const after = cornerCounts([
      { rel: '/x.tsx', src: `${imp}const a = <Card padding="md">x</Card>; const b = <div className="rounded-md">y</div>;` },
    ]);
    expect(largeShare(after).share).toBe(largeShare(before).share);
    // `plain` is the same corner, and a wrapper the kit itself owns counts once
    // at ITS call site, not again inside the kit file.
    const plain = cornerCounts([{ rel: '/y.tsx', src: `${imp}const a = <Card plain>x</Card>;` }]);
    expect(plain.get('lg')).toBe(1);
  });

  it('but a hand-drawn smaller corner still lowers it, and can turn the floor red', () => {
    const imp = "import { Card } from '@/components/ui/Card';\n";
    const cards = Array.from({ length: 9 }, () => '<Card>x</Card>').join('');
    const fine = cornerCounts([{ rel: '/a.tsx', src: `${imp}const a = <>${cards}<div className="rounded-md" /></>;` }]);
    expect(largeShare(fine).share).toBe(0.9);
    const worse = cornerCounts([
      { rel: '/a.tsx', src: `${imp}const a = <>${cards}<div className="rounded-md" /><section className="rounded-sm" /></>;` },
    ]);
    expect(largeShare(worse).share).toBeLessThan(largeShare(fine).share);
    expect(largeShare(worse).share > 0.9).toBe(false);
  });

  it('and a kit piece that names a smaller corner counts as that corner, not the large one', () => {
    const src =
      "import { Card } from '@/components/ui/Card';\nimport { Button } from '@/components/ui/Button';\n" +
      'const a = <><Card className="rounded-' + 'md p-4">x</Card><Button onClick={() => go(a > b)} className="rounded-' + 'full">y</Button></>;';
    const c = cornerCounts([{ rel: '/b.tsx', src }]);
    expect(c.get('lg') ?? 0).toBe(0);
    expect(c.get('md')).toBe(1);
    expect(c.get('full')).toBe(1);
  });

  it('and a component that only shares the name, not the kit, is not counted', () => {
    const c = cornerCounts([
      { rel: '/c.tsx', src: 'function Card() { return null }\nconst a = <Card />; const b = <CardHeader />;' },
    ]);
    expect(c.get('lg') ?? 0).toBe(0);
  });

  it('and the kit pieces it credits still draw that corner themselves', () => {
    // If the shared Card ever moves to another corner, the credit above would
    // be a lie: so each piece is read here, and must draw the large corner
    // (and no other sized step) or hand the work to a piece that does.
    for (const k of KIT) {
      const src = code(readFileSync(join(process.cwd(), 'src/components/ui', `${k.file}.tsx`), 'utf8'));
      const body = src.slice(src.indexOf(`export function ${k.name}(`)).split(/\nexport /)[0];
      expect(body.length, `${k.name} مش موجود`).toBeGreaterThan(0);
      if (k.via) {
        expect(body, `${k.name} ما عاد يرسم عبر ${k.via}`).toMatch(new RegExp(`<${k.via}(?![\\w.])`));
        continue;
      }
      const steps = [...body.matchAll(RADIUS)].map((m) => m[1] ?? BARE).filter((s) => s !== 'full' && s !== 'none');
      expect(steps, `${k.name} ما عاد يرسم الزاوية الكبيرة`).toContain('lg');
      expect(steps.every((s) => s === 'lg'), `${k.name} يرسم زاوية غير الكبيرة: ${steps.join(' ')}`).toBe(true);
    }
  });
});

/**
 * The kit pieces that draw the large corner for their caller. `via` is a
 * piece that draws nothing itself but renders another kit piece.
 */
const KIT: { name: string; file: string; via?: string }[] = [
  { name: 'Card', file: 'Card' },
  { name: 'KpiCard', file: 'Card' },
  { name: 'Button', file: 'Button' },
  { name: 'IconButton', file: 'IconButton', via: 'Button' },
  { name: 'StatTile', file: 'StatTile', via: 'Card' },
];
const KIT_FILES = new Set(KIT.map((k) => `/src/components/ui/${k.file}.tsx`));

/** The opening tag from `at` to its closing `>`, skipping braces and strings. */
function openingTag(s: string, at: number): string {
  let depth = 0;
  let quote = '';
  for (let i = at + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== '\\') quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return s.slice(at, i + 1);
  }
  return s.slice(at);
}

/**
 * Every corner step in the files: the words written by hand, plus one large
 * corner for each use of a kit piece that draws it and names no corner of
 * its own. The kit's own files do not credit themselves (StatTile's inner
 * Card is StatTile's corner, counted where StatTile is used).
 */
function cornerCounts(files: { rel: string; src: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (step: string) => counts.set(step, (counts.get(step) ?? 0) + 1);
  for (const { rel, src } of files) {
    const c = code(src);
    for (const m of c.matchAll(RADIUS)) add(m[1] ?? BARE);
    if (KIT_FILES.has(rel)) continue;
    for (const k of KIT) {
      const imported = new RegExp(
        `import\\s*\\{[^}]*\\b${k.name}\\b[^}]*\\}\\s*from\\s*'(?:@/components/ui|\\.)/${k.file}'`
      ).test(c);
      if (!imported) continue;
      for (const m of c.matchAll(new RegExp(`<${k.name}(?![\\w.])`, 'g'))) {
        const tag = openingTag(c, m.index ?? 0);
        if (!new RegExp(RADIUS.source).test(tag)) add('lg');
      }
    }
  }
  return counts;
}

/** The commonest sized step and its share of every sized corner. */
function largeShare(counts: Map<string, number>): { top: string; share: number } {
  const sized = [...counts.entries()].filter(([k]) => k !== 'full' && k !== 'none');
  const total = sized.reduce((s, [, n]) => s + n, 0);
  const [top, topCount] = sized.sort((a, b) => b[1] - a[1])[0];
  return { top, share: topCount / total };
}

/**
 * The guard on the guard: a shop's design is still the shop's.
 */
describe('a seller’s own pages', () => {
  it('were not restyled along with the dashboard', () => {
    const shop = readFileSync(join(process.cwd(), 'src/components/landing/blocks/Countdown.tsx'), 'utf8');
    // Not an assertion about a particular class — an assertion that the
    // sweep did not reach in here at all. Their corners are their own.
    expect(shop.includes('--sys-'), 'متغيّر لوحة التحكم تسرّب إلى صفحة بائع').toBe(false);
  });
});

/**
 * ONE SET OF HEIGHTS.
 *
 * Measured on the orders screen before this: an input at 34px, a button at
 * 30, a second button at 32 and a dropdown at 36 - four heights in one row.
 * Nobody chose four. The height was padding plus whatever font size the
 * size happened to carry, so it was arithmetic, and arithmetic drifts.
 *
 *   sm  32px  a control inside a row
 *   md  40px  everything else: toolbars, forms, dialogs
 *   lg  48px  the one action a screen is for
 *
 * AND 44px ON A PHONE, for every step below it. Those three are a rhythm
 * for a mouse; Stage 8 measured the same controls at 360px against the
 * 44px gate and they failed it. So each step states TWO heights — the
 * phone's first, the desk's behind `md:` — and the guard checks both,
 * because a scale with one of them missing is the drift this file exists
 * to catch.
 *
 * A chip or a badge is not a control and has no stated height - it is as
 * tall as its text, which is what makes it read as a label rather than as
 * something to press.
 */
describe('the height of a control', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('is stated by the shared button, not left to arithmetic', () => {
    const src = read('src/components/ui/Button.tsx');
    // A thumb first, then the desk.
    expect(src).toMatch(/sm:\s*'h-11 md:h-8/);
    expect(src).toMatch(/md:\s*'h-11 md:h-10/);
    // `lg` is 44 everywhere. 18/11 (R2a): it was `h-12` (48) — «already
    // past the gate, and the one action a screen is for». The restructure
    // fixes the kit at three sizes, 32 · 40 · 44, and 44 is the thumb's size
    // on a phone; on a desk the largest step is therefore the same 44 and
    // not a fourth height. No call site used `lg`, so nothing moved.
    expect(src).toMatch(/lg:\s*'h-11 px-5/);
    expect(src, 'lg رجع ٤٨').not.toMatch(/lg:\s*'h-12/);
    // The square twins (the icon button) state the same two steps.
    expect(src).toMatch(/sm:\s*'h-11 w-11 md:h-8 md:w-8/);
    expect(src).toMatch(/md:\s*'h-11 w-11 md:h-10 md:w-10/);
  });

  it('and by the shared field, so a field matches the button beside it', () => {
    const src = read('src/components/ui/Input.tsx');
    // The input and the select. A textarea is multi-line and is not one.
    expect((src.match(/'h-11 md:h-10 w-full/g) ?? []).length).toBe(2);
  });

  it('and a field written by hand carries both heights too', () => {
    // Sixty-nine fields are written out rather than drawn by `Input`, so
    // raising the component did not raise them. Any that still say a bare
    // `h-10` is 40px under a thumb.
    const offenders: string[] = [];
    for (const { rel, src } of dashboardFiles()) {
      for (const [i, line] of stripComments(src).split('\n').entries()) {
        if (/\bw-full h-10 px-3\b/.test(line)) offenders.push(`${rel}:${i + 1}`);
      }
    }
    expect(offenders, `حقلٌ بارتفاع ٤٠ على الهاتف:\n${offenders.slice(0, 12).join('\n')}`).toEqual([]);
  });

  it('and 36px is gone - the step that fit nothing', () => {
    const offenders: string[] = [];
    for (const { rel, src } of systemFiles()) {
      // Match and slice the SAME text: indices from the stripped source
      // point at the wrong place in the original, so the window that is
      // supposed to see the matching width sees something else entirely.
      const c = code(src);
      for (const m of c.matchAll(/(?<![\w.-])h-9(?![\d.])/g)) {
        const at = m.index ?? 0;
        const around = c.slice(Math.max(0, at - 90), at + 90);
        // A matching width, or an image fit: a square icon button, an
        // avatar, a logo box. Their height belongs to the shape.
        if (/\bw-9\b/.test(around) || /object-(?:contain|cover)/.test(around)) continue;
        offenders.push(rel + ': ' + around.replace(/\s+/g, ' ').trim().slice(0, 70));
      }
    }
    expect(offenders, 'ارتفاع ٣٦ عاد:\n' + offenders.slice(0, 10).join('\n')).toEqual([]);
  });

  it('and a square stayed square', () => {
    // The sweep that gave every control a stated height reached the icon
    // buttons and the avatars too, and a 36x36 avatar came out 40x36.
    const offenders: string[] = [];
    for (const { rel, src } of systemFiles()) {
      for (const m of src.matchAll(/class[nN]ame=\{?[`"']([^`"']*)[`"']/g)) {
        if (/\bw-9\b/.test(m[1]) && /\bh-10\b/.test(m[1])) offenders.push(rel + ': ' + m[1].slice(0, 60));
      }
    }
    expect(offenders, 'شكل مربّع صار مستطيلاً:\n' + offenders.join('\n')).toEqual([]);
  });
});

/**
 * ONE LADDER OF TEXT SIZES, AND A FLOOR UNDER IT.
 *
 * Fourteen sizes were in use, five of them measured by hand because
 * Tailwind's ladder stops at 12px: 11, 10.5, 10, 9.5, 9. Three hundred
 * lines sat on one of the bottom four.
 *
 * Nine-pixel Arabic is not small text, it is a smudge. The script carries
 * meaning in the marks above and below the letters, and at that size they
 * merge into the line - in a warehouse, at arm's length, in bad light. So
 * `caption` at 11px is the floor, and there is nothing below it.
 */
describe('the size of text', () => {
  const SIZE = /(?<![\w-])text-(\[[0-9.]+(?:px|rem)\]|caption|xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g;

  it('is never measured by hand', () => {
    const offenders: string[] = [];
    for (const { rel, src } of systemFiles()) {
      for (const m of code(src).matchAll(SIZE)) {
        if (m[1].startsWith('[')) offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders, `حجم خطّ مقاس باليد:\n${offenders.slice(0, 20).join('\n')}`).toEqual([]);
  });

  it('and never smaller than the floor', () => {
    // The guard is on the token, because the pixels live in one place now.
    const globals = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    // The scale is 12 · 13 · 14 · 16 · 20 · 24 · 32, and 12 is the floor.
    // Anything named below it is a step somebody added by hand.
    for (const m of globals.matchAll(/--text-([\w-]+):\s*([0-9.]+)rem/g)) {
      if (m[1].includes('--')) continue;
      expect(Number(m[2]) * 16, `--text-${m[1]} تحت أرضيّة ١٢ بكسل`).toBeGreaterThanOrEqual(12);
    }
    expect(globals, 'درجة ١٣ بكسل مفقودة').toContain('--text-note: 0.8125rem');
    expect(globals, 'درجة ٣٢ بكسل مفقودة').toContain('--text-display: 2rem');
  });

  it('and the floor leaves room for Arabic to breathe', () => {
    const globals = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const m = /--text-note--line-height:\s*([0-9.]+)/.exec(globals);
    expect(m, 'أصغر حجم بلا ارتفاع سطر').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1.5);
  });

  it('and adding it did not reach into a seller’s pages', () => {
    // It lives in the file every page loads, which is only acceptable
    // because it ADDS a utility and overrides nothing.
    const globals = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const theme = /@theme\s*\{([^}]*)\}/.exec(globals);
    expect(theme, 'اختفت كتلة السلّم').toBeTruthy();
    const ADDED = ['--text-note', '--text-display', '--radius-card', '--radius-sheet',
      '--ease-standard', '--shadow-raised', '--shadow-overlay'];
    for (const line of theme![1].split('\n')) {
      const name = /(--[\w-]+):/.exec(line);
      if (!name) continue;
      expect(
        ADDED.some((a) => name[1].startsWith(a)),
        `${name[1]} يعيد تعريف درجة قائمة — وهذا يصل إلى صفحات البائعين`
      ).toBe(true);
    }
  });
});

/**
 * TWO ELEVATIONS, AND BOTH KNOW WHICH THEME THEY ARE IN.
 *
 * Eight shadow values were in use across forty-seven places, and one of
 * them was black written by hand: `rgba(0,0,0,0.1)` is a soft edge on
 * white and is literally nothing on a near-black page. A card in the dark
 * theme was separated from the page by no shadow at all, in thirteen
 * places, and nobody noticed because nobody had looked at the dark theme
 * with a card in front of them.
 */
describe('depth', () => {
  const SHADOW = /(?<![\w-])shadow-(\[[^\]]+\]|xs|sm|md|lg|xl|2xl|none|inner|card|raised)(?![\w-])/g;

  it('comes in two steps and no more', () => {
    const offenders: string[] = [];
    for (const { rel, src } of systemFiles()) {
      for (const m of code(src).matchAll(SHADOW)) {
        if (m[1] === 'raised' || m[1] === 'none') continue;
        // A 9999px spread is not depth: it is the trick that dims
        // everything outside a cut-out, over a camera viewfinder.
        if (m[1].includes('9999px')) continue;
        offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders, `ظلّ خارج الدرجتين:\n${offenders.slice(0, 15).join('\n')}`).toEqual([]);
  });

  it('and the two steps resolve through the theme, not through a fixed colour', () => {
    // The whole reason the dark theme now has usable depth. Writing the
    // colour into the utility instead of into the theme puts it straight
    // back where it was: one shadow, and a theme where it does nothing.
    const globals = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(globals, 'الظلّ المرفوع لم يعد يتبع القلم').toMatch(/--shadow-raised:\s*var\(--sys-shadow-raised\)/);
    expect(globals, 'ظلّ الطبقة العائمة لم يعد يتبع القلم').toMatch(
      /--shadow-overlay:\s*var\(--sys-shadow-overlay\)/
    );
  });

  it('and never a colour written by hand, which cannot follow the theme', () => {
    const offenders: string[] = [];
    for (const { rel, src } of systemFiles()) {
      for (const m of code(src).matchAll(SHADOW)) {
        if (/rgba?\(/.test(m[1]) && !m[1].includes('9999px')) offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders, `ظلّ بلونٍ مكتوبٍ بيده:\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * THE ROOM INSIDE A SURFACE.
 *
 * Eleven paddings were in use inside cards, and two of them were doing the
 * same job: "nothing here" was 24px on twenty-three screens and 32px on
 * eight, so the empty message sat differently depending on which screen
 * you happened to be on. Nobody chose two; two happened.
 *
 * Seven remain, and each answers a different question:
 *
 *   p-1    the inset of a segmented control, around its own segments
 *   p-1.5  the inset of an icon button, or of a sheet that holds a list
 *   p-2.5  a note strip sitting inside a card
 *   p-3    a dense row card in a list
 *   p-4    a card or a panel — the default
 *   p-6    "nothing here", inside a screen
 *   p-8    a whole page that is only a message
 */
describe('the room inside a surface', () => {
  const CLASS = /class[nN]ame=\{?[`"']([^`"']*)[`"']/g;
  const PAD = /(?<![\w-])p-(\d+(?:\.\d+)?)(?![\w-])/g;
  const ALLOWED = new Set(['1', '1.5', '2.5', '3', '4', '6', '8']);

  const isSurface = (cls: string) =>
    cls.includes('rounded-lg') &&
    cls.includes('border') &&
    (cls.includes('--sys-card') || cls.includes('--sys-surface'));

  it('comes from the scale, with no half-steps invented along the way', () => {
    const offenders: string[] = [];
    for (const { rel, src } of systemFiles()) {
      for (const m of code(src).matchAll(CLASS)) {
        if (!isSurface(m[1])) continue;
        for (const pm of m[1].matchAll(PAD)) {
          if (!ALLOWED.has(pm[1])) offenders.push(`${rel}: p-${pm[1]}`);
        }
      }
    }
    expect(offenders, `حشوٌ خارج السلّم:\n${offenders.slice(0, 15).join('\n')}`).toEqual([]);
  });

  /*
   * 18/11 — THE KIT'S CARD IS COUNTED WHERE IT IS USED (as the corners above).
   *
   * Before: the sample was only panels whose surface was written by hand
   * (corner + edge + card fill in one class string). Screens moving onto the
   * kit's Card stop writing that string — the kit writes it — and the last
   * hand-written one (the penalties screen) moved in #385, so the sample was
   * empty and «the sample is not empty» went red although no panel changed
   * its room. After: a use of the kit's Card that is centred and muted is the
   * same panel, and its room is read from its `padding` step (or a padding
   * written in its own class, which wins). Nothing is excused; the check is
   * the same one, and the pins below keep the counting honest.
   */
  it('and every "nothing here" panel says it with the same room around it', () => {
    // The property, not the number: whatever the value is, there is one of
    // it. A screen whose empty state is roomier than the next screen's
    // reads as two different products.
    const found = emptyPanels(systemFiles());
    // A sample this small means the counting lost the panels again, and
    // «one room» would then be true of nothing.
    const total = [...found.values()].reduce((s, f) => s + f.length, 0);
    expect(total, 'العيّنة فاضية أو شبه فاضية: الحارس ما عاد يلاقي لوحات «لا شيء هنا»').toBeGreaterThanOrEqual(3);
    const spread = [...found.entries()].map(([pad, files]) => `p-${pad}: ${files.join(' ')}`);
    expect([...found.keys()], `أحجام مختلفة لنفس الحالة — ${spread.join(', ')}`).toHaveLength(1);
  });

  it('counts a kit Card at its call site, and its room from its padding step', () => {
    const imp = "import { Card } from '@/components/ui/Card';\n";
    const muted = 'text-center text-sm text-[var(--sys-muted-foreground)]';
    const f = emptyPanels([
      { rel: '/a.tsx', src: `${imp}const a = <Card padding="lg" className="${muted}">x</Card>;` },
      { rel: '/b.tsx', src: `${imp}const b = <Card\n  plain\n  padding="lg"\n  className="${muted}"\n>x</Card>;` },
      { rel: '/c.tsx', src: `const c = <p className="rounded-lg border bg-[var(--sys-card)] p-6 ${muted}">x</p>;` },
    ]);
    expect([...f.entries()]).toEqual([['6', ['/a.tsx', '/b.tsx', '/c.tsx']]]);
  });

  it('and a panel with a different room — by hand or through the kit — is a second size', () => {
    const imp = "import { Card } from '@/components/ui/Card';\n";
    const muted = 'text-center text-sm text-[var(--sys-muted-foreground)]';
    const base = { rel: '/a.tsx', src: `${imp}const a = <Card padding="lg" className="${muted}">x</Card>;` };
    const cases = [
      `const c = <p className="rounded-lg border bg-[var(--sys-card)] p-8 ${muted}">x</p>;`,
      `${imp}const c = <Card padding="md" className="${muted}">x</Card>;`,
      `${imp}const c = <Card padding="lg" className="p-8 ${muted}">x</Card>;`,
      // No padding at all is a room too: none.
      `${imp}const c = <Card className="${muted}">x</Card>;`,
    ];
    for (const src of cases) {
      const f = emptyPanels([base, { rel: '/c.tsx', src }]);
      expect(f.size, src).toBe(2);
    }
  });

  it('and does not count what is not a nothing-here panel, or not the kit', () => {
    const imp = "import { Card } from '@/components/ui/Card';\n";
    const f = emptyPanels([
      // Not muted: a centred card that says something.
      { rel: '/a.tsx', src: `${imp}const a = <Card padding="md" className="text-center">x</Card>;` },
      // A whole page that is only a message centres itself.
      { rel: '/b.tsx', src: `${imp}const b = <Card padding="md" className="mx-auto text-center text-[var(--sys-muted-foreground)]">x</Card>;` },
      // A local component that shares the name only.
      { rel: '/c.tsx', src: 'function Card() { return null }\nconst c = <Card padding="md" className="text-center text-[var(--sys-muted-foreground)]" />;' },
    ]);
    expect(f.size).toBe(0);
  });

  it('and the padding steps it reads are still the kit Card\'s own', () => {
    // If the Card's steps move, the reading above would be a lie.
    const src = readFileSync(join(process.cwd(), 'src/components/ui/Card.tsx'), 'utf8');
    const steps = /const CARD_PADDING = \{([^}]*)\}/.exec(src)?.[1] ?? '';
    for (const [step, pad] of Object.entries(CARD_PAD)) {
      expect(steps, `خطوة الحشو ${step} بالـCard تغيّرت`).toContain(pad ? `${step}: 'p-${pad}'` : `${step}: ''`);
    }
  });
});

/** The kit Card's `padding` steps, as the room they give. */
const CARD_PAD: Record<string, string> = { none: '', sm: '3', md: '4', lg: '6' };

/**
 * Every "nothing here" panel and its room: a centred, muted surface, written
 * by hand or drawn by the kit's Card. A page-sized message (centred with
 * auto margins) is a different thing and is left out. A panel with no
 * padding at all is recorded as room `0`, not skipped.
 */
function emptyPanels(files: { rel: string; src: string }[]): Map<string, string[]> {
  const CLASS = /class[nN]ame=\{?[`"']([^`"']*)[`"']/g;
  const PAD = /(?<![\w-])p-(\d+(?:\.\d+)?)(?![\w-])/;
  const found = new Map<string, string[]>();
  const add = (pad: string, rel: string) => found.set(pad, [...(found.get(pad) ?? []), rel]);
  const isEmptyMessage = (s: string) =>
    s.includes('text-center') && s.includes('--sys-muted-foreground') && !s.includes('mx-auto');
  for (const { rel, src } of files) {
    const c = code(src);
    for (const m of c.matchAll(CLASS)) {
      const cls = m[1];
      const surface =
        cls.includes('rounded-lg') && cls.includes('border') &&
        (cls.includes('--sys-card') || cls.includes('--sys-surface'));
      if (!surface || !isEmptyMessage(cls)) continue;
      add(PAD.exec(cls)?.[1] ?? '0', rel);
    }
    if (KIT_FILES.has(rel)) continue;
    if (!/import\s*\{[^}]*\bCard\b[^}]*\}\s*from\s*'(?:@\/components\/ui|\.)\/Card'/.test(c)) continue;
    for (const m of c.matchAll(/<Card(?![\w.])/g)) {
      const tag = openingTag(c, m.index ?? 0);
      if (!isEmptyMessage(tag)) continue;
      const step = /\bpadding=["']([a-z]+)["']/.exec(tag)?.[1] ?? 'none';
      add(PAD.exec(tag)?.[1] ?? (CARD_PAD[step] || '0'), rel);
    }
  }
  return found;
}
