/**
 * NO LOCAL COPY OF A KIT PART, NO CONSTANT NOBODY READS (R19b, 19/11).
 *
 * R19b took out the copies the restructure left behind: a text box drawn from a class constant that the kit's `Input` also
 * draws, a hand-made overlay beside the kit's `Modal`, a button that restated the kit `Button`'s tones, a chip that restated
 * `StatusChip`'s colours, and three private constants nothing read. This test is what stops the next screen from writing
 * them again.
 *
 * Two sweeps over every `.tsx` under src/components outside the storefront owner's files (their paths are not ours until R18),
 * and a few pins on the files R19b changed. Each detector has a negative test below that plants the thing it must catch.
 *
 * The class names the detector looks for are built from pieces, never written whole: Tailwind reads tests and comments.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const j = (...p: string[]) => p.join('');

/** The storefront owner's files: they keep their own copies until R18. */
const OWNER: RegExp[] = [
  /^src\/components\/(landing-editor|landing|landing-flow|storefront|store|store-admin)\//,
  /(^|\/)store-admin\//,
  /(^|\/)Store[A-Za-z]*Screen\.tsx$/,
  /(^|\/)LandingPage[A-Za-z]*Screen\.tsx$/,
];
const isOwner = (rel: string) => OWNER.some((r) => r.test(rel));

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = walk(path.join(ROOT, 'src', 'components'), [])
  .map((p) => ({ rel: path.relative(ROOT, p).split(path.sep).join('/'), src: fs.readFileSync(p, 'utf8') }))
  .filter((f) => !isOwner(f.rel));
/** The kit's own files draw the box; they are the thing the others must use. */
const SCREENS = FILES.filter((f) => !f.rel.startsWith('src/components/ui/'));

/* ───────────── 1 · a class constant that draws what the kit's Input draws ───────────── */

/**
 * `const NAME = '…'` whose string is a text box: a rounded edge, the card fill and a primary-coloured focus edge. That is
 * `Input`/`Select`/`Textarea` written out again; a field uses the kit part (its label, its hint and its focus ring come with it).
 */
function inputLookConstants(src: string): string[] {
  const needs = [j('rounded', '-lg'), j('bg-[var(--sys-', 'card)]'), j('focus:border-[var(--sys-', 'primary)]'), j('border', ' ')];
  const out: string[] = [];
  for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*\n?\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2/gm)) {
    const value = m[3] + ' ';
    if (needs.every((n) => value.includes(n))) out.push(m[1]);
  }
  return out;
}

/**
 * What is still on the list, each with its reason. The list may only shrink: a name that is not here fails the day it is written.
 *
 * Two are kept on purpose — a compact inline box with its own width (a toolbar row's size picker, a template row's name and
 * three selects); the kit's field is a full-width block inside a wrapper, which would break those rows. The other seven are
 * copies R19b found after its twelve-file cap was reached (19/11); they wait for the second R19b pull request and each leaves
 * this list in the pull request that replaces its constant.
 */
const WAITING = 'نسخة وجدتها R19b بعد سقف 12 ملف في الـPR — بانتظار الدفعة الثانية، وتطلع من هالقائمة معها';
const KEPT_FOR_NOW: Record<string, string> = {
  'src/components/labels/LabelSize.tsx': 'مقاس البوليصة: قائمة وخانتا عرض وطول بعرض صغير على سطر شريط الأدوات — حقل العدّة كتلة بعرض كامل',
  'src/components/settings/MessageTemplatesCard.tsx': 'صف القالب: اسم وثلاث قوائم بعرض محدّد على سطر واحد — حقل العدّة كتلة بعرض كامل',
  'src/components/production/BatchCostDialog.tsx': WAITING,
  'src/components/screens/confirmation/ActionDialogs.tsx': WAITING,
  'src/components/screens/users/UserSalary.tsx': WAITING,
  'src/components/screens/users/UserShift.tsx': WAITING,
  'src/components/settings/PenaltyRulesCard.tsx': WAITING,
  'src/components/settings/PerformanceSettingsCard.tsx': WAITING,
  'src/components/settings/PostOrderOfferCard.tsx': WAITING,
};

describe('a text box is the kit’s Input, not a class constant', () => {
  it('no screen outside the owner’s files keeps a class constant that draws a text box', () => {
    const offenders = SCREENS.filter((f) => inputLookConstants(f.src).length > 0 && !(f.rel in KEPT_FOR_NOW)).map(
      (f) => `${f.rel}: ${inputLookConstants(f.src).join(', ')}`
    );
    expect(offenders, 'استعمل Input أو Select أو Textarea من العدّة بدل ثابت فيه شكل الحقل').toEqual([]);
  });

  it('every name still on the list still has its constant, and says why', () => {
    for (const [rel, why] of Object.entries(KEPT_FOR_NOW)) {
      const f = FILES.find((x) => x.rel === rel);
      expect(f, `${rel} ما عاد موجود — شيله من القائمة`).toBeTruthy();
      expect(inputLookConstants(f!.src).length, `${rel} ما عاد فيه ثابت — شيله من القائمة`).toBeGreaterThan(0);
      expect([...why].length, rel).toBeGreaterThan(20);
    }
  });
});

/* ───────────── 2 · a private constant or function nothing in its file reads ───────────── */

/**
 * A top-level `const`/`function`/`let` that is not exported and whose name appears once in its file — the line that declares it.
 * (A name spread as `...NAME` or called counts as read; one that only a comment mentions does not.)
 */
function unreadPrivateNames(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const m of noComments.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1].replace(/\$/g, '\\$');
    const count = (noComments.match(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g')) ?? []).length;
    if (count <= 1) out.push(m[1]);
  }
  return out;
}

describe('a private constant or function is read by something', () => {
  it('no component file outside the owner’s files declares a private name nothing reads', () => {
    const offenders = SCREENS.flatMap((f) => unreadPrivateNames(f.src).map((n) => `${f.rel}: ${n}`));
    expect(offenders, 'اسم خاص بالملف ما يقرأه شي — احذفه').toEqual([]);
  });
});

/* ───────────── 3 · pins on the files R19b changed ───────────── */

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('what R19b put on the kit stays on it', () => {
  it('the campaigns screen draws its two dialogs with the kit’s Modal and its empty state with EmptyState', () => {
    const src = read('src/components/screens/CampaignsScreen.tsx');
    expect(src).toMatch(/import \{ Modal \} from '@\/components\/ui\/Modal'/);
    expect(src).toMatch(/import \{ EmptyState \} from '@\/components\/ui\/EmptyState'/);
    expect(src.includes(j('fixed ', 'inset-0')), 'غطاء حوار مكتوب باليد').toBe(false);
    expect(src.includes(j('border-', 'dashed')), 'صندوق فاضي مكتوب باليد').toBe(false);
  });

  it('the geo screen’s three field helpers are the kit’s Input, not boxes written out again', () => {
    const src = read('src/components/screens/GeoSettingsScreen.tsx');
    expect(src).toMatch(/import \{ Input \} from '@\/components\/ui\/Input'/);
    expect(src).not.toMatch(/^function Input\(/m);
    const helpers = src.slice(src.indexOf('function TextField('), src.indexOf('function CurrencyField('));
    expect(helpers).toMatch(/<Input\b/);
    expect(helpers).not.toMatch(/<input\b/);
  });

  it('the call sheet’s buttons are the kit’s Button, with the screen’s own handler', () => {
    const src = read('src/components/confirmation/CallOutcomeSheet.tsx');
    const body = src.slice(src.indexOf('function SheetButton('), src.indexOf('const ICON:'));
    expect(body).toMatch(/<Button\b/);
    expect(body).not.toMatch(/<button\b/);
    // the handler returns nothing to the kit, so a promise cannot start a second busy flag
    expect(body).toMatch(/onClick=\{\(\) => \{\s*onClick\(\);\s*\}\}/);
  });

  it('the import dialog’s counts are the kit’s StatusChip', () => {
    const src = read('src/components/orders/ImportOrdersDialog.tsx');
    const body = src.slice(src.indexOf('function Pill('));
    expect(src).toMatch(/import \{ StatusChip \} from '@\/components\/ui\/StatusChip'/);
    expect(body).toMatch(/<StatusChip\b/);
    expect(body).not.toMatch(/<span\b/);
  });

  it('the five screens draw their text boxes and lists with the kit, none with a constant', () => {
    for (const rel of [
      'src/components/settings/AdAccountsCard.tsx',
      'src/components/settings/CustomConversionsCard.tsx',
      'src/components/screens/AiSettingsScreen.tsx',
      'src/components/screens/CampaignsScreen.tsx',
      'src/components/screens/TelegramAliasesDialog.tsx',
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/className=\{[^}]*\b(INPUT|SELECT)\b/);
      expect(src, rel).not.toMatch(/<(input|select)\b/);
    }
  });
});

/* ───────────── the detectors themselves (negative tests) ───────────── */

describe('the detectors', () => {
  const look = [j('w-full rounded', '-lg border border-[var(--sys-', 'border)] bg-[var(--sys-', 'card)] px-3 py-2 text-sm'), j('focus:border-[var(--sys-', 'primary)]')].join(' ');

  it('catches a text-box class constant, in single quotes, on the next line and in backticks', () => {
    expect(inputLookConstants(`const INPUT = '${look}';`)).toEqual(['INPUT']);
    expect(inputLookConstants(`const FIELD =\n  '${look}';`)).toEqual(['FIELD']);
    expect(inputLookConstants('const BOX = `' + look + '`;')).toEqual(['BOX']);
  });

  it('does not flag a constant that is not a text box', () => {
    expect(inputLookConstants(`const CARD = '${j('rounded', '-lg border bg-[var(--sys-', 'card)] p-4')}';`)).toEqual([]);
    expect(inputLookConstants(`const WORDS = { a: '${look}' };`)).toEqual([]);
  });

  it('catches a private constant nothing reads, and not one that is read', () => {
    expect(unreadPrivateNames('const POLL_MS = 60_000;\nexport function A() { return 1; }')).toEqual(['POLL_MS']);
    expect(unreadPrivateNames('function Metric() { return null; }\nexport function A() { return 1; }')).toEqual(['Metric']);
    expect(unreadPrivateNames('const BLANK = {};\nexport function A() { return { ...BLANK }; }')).toEqual([]);
    expect(unreadPrivateNames('function B() { return 1; }\nexport function A() { return B(); }')).toEqual([]);
  });

  it('a name only a comment mentions is still unread', () => {
    expect(unreadPrivateNames('// POLL_MS is gone\nconst POLL_MS = 1;')).toEqual(['POLL_MS']);
    expect(unreadPrivateNames('/* POLL_MS */\nconst POLL_MS = 1;\nexport const a = 1;')).toEqual(['POLL_MS']);
  });
});
