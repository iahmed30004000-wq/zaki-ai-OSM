/**
 * ONE NAME FOR EACH BUTTON LOOK (R19a, 19/11).
 *
 * The kit's `Button` has four looks: primary · secondary · quiet · danger.
 * Three older names still answer (see `LegacyVariant` in
 * src/components/ui/Button.tsx): the framed one, the quiet one and the
 * green one. R19a renamed every call site outside the storefront owner's
 * files to the four names. The storefront owner's files keep the old names
 * until R18 (their paths are not ours), so the type stays — and this test is
 * what stops a new screen from writing an old name again and teaching the
 * next screen to copy it.
 *
 * The old names are built from pieces, never written whole: Tailwind reads
 * tests and comments, and one of them is a utility class.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const LEGACY = [['out', 'line'], ['gh', 'ost'], ['suc', 'cess']].map(([a, b]) => a + b);

/** The storefront owner's files (decision 1 of R19). They keep the old names until R18. */
const OWNER: RegExp[] = [
  /^src\/components\/(landing-editor|landing|landing-flow|storefront|store|store-admin)\//,
  /^src\/app\/(s|lp)\//,
  /(^|\/)store-admin\//,
  /(^|\/)Store[A-Za-z]*Screen\.tsx$/,
  /(^|\/)LandingPage[A-Za-z]*Screen\.tsx$/,
];
const isOwner = (rel: string) => OWNER.some((r) => r.test(rel));

/** End (exclusive) of the JSX opening tag that starts at `start`, skipping strings and `{…}`. */
function tagEnd(src: string, start: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i + 1;
  }
  return -1;
}

function exprEnd(s: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === '\\') j++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return s.length - 1;
}

/**
 * Every old name a `<Button>` or `<IconButton>` is given in `src`: as a
 * literal (`variant="…"`) or inside an expression (`variant={x ? '…' : …}`).
 * Returns `line: name` for each.
 */
function legacyNamesIn(src: string): string[] {
  const found: string[] = [];
  const lineOf = (i: number) => src.slice(0, i).split('\n').length;
  const tagRe = /<(Button|IconButton)(?=[\s>/])/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    const end = tagEnd(src, m.index);
    if (end < 0) break;
    const tag = src.slice(m.index, end);
    const attrRe = /\svariant=("([^"]*)"|'([^']*)'|\{)/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(tag))) {
      const at = m.index + a.index;
      const lit = a[2] ?? a[3];
      if (lit !== undefined) {
        if (LEGACY.includes(lit)) found.push(`${lineOf(at)}: ${lit}`);
        continue;
      }
      const open = a.index + a[0].length - 1;
      const expr = tag.slice(open, exprEnd(tag, open) + 1);
      for (const s of expr.matchAll(/(['"`])([a-z]+)\1/g)) {
        if (LEGACY.includes(s[2])) found.push(`${lineOf(at)}: ${s[2]}`);
      }
    }
    tagRe.lastIndex = end;
  }
  return found;
}

const ROOT = path.resolve(__dirname, '..', '..');

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('no screen outside the storefront owner’s files writes an old button name', () => {
  it('every <Button>/<IconButton> outside the owner’s paths says primary, secondary, quiet or danger', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, 'src'), [])) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (isOwner(rel)) continue;
      for (const hit of legacyNamesIn(fs.readFileSync(file, 'utf8'))) offenders.push(`${rel}:${hit}`);
    }
    // An old name here: write `secondary` for the framed one, `quiet` for the
    // quiet one, `primary` for the green one (see `LegacyVariant` in Button.tsx).
    expect(offenders).toEqual([]);
  });

  it('the old names still type-check, because the owner’s files still use them (until R18)', () => {
    const button = fs.readFileSync(path.join(ROOT, 'src/components/ui/Button.tsx'), 'utf8');
    expect(button).toMatch(/type LegacyVariant =/);
    expect(button).toMatch(/ONLY in the storefront owner's files until R18/);
  });
});

describe('the scanner itself (negative tests)', () => {
  const [framed, quiet, green] = LEGACY;

  it('catches a literal old name on a Button', () => {
    expect(legacyNamesIn(`<Button size="sm" variant="${framed}">x</Button>`)).toEqual([`1: ${framed}`]);
  });

  it('catches it on an IconButton and in single quotes', () => {
    expect(legacyNamesIn(`<IconButton label="a" variant='${quiet}' />`)).toEqual([`1: ${quiet}`]);
  });

  it('catches an old name inside an expression, on a tag spread over lines', () => {
    const src = `const a = 1;\n<Button\n  type="button"\n  variant={busy ? '${green}' : 'primary'}\n  onClick={() => go({ a: 1 })}\n>\n  ok\n</Button>`;
    expect(legacyNamesIn(src)).toEqual([`4: ${green}`]);
  });

  it('a tag with an arrow function before the variant is still read to its end', () => {
    expect(legacyNamesIn(`<Button onClick={() => a > b} variant="${quiet}">x</Button>`)).toEqual([`1: ${quiet}`]);
  });

  it('leaves the four names alone', () => {
    expect(legacyNamesIn(`<Button variant="secondary" /><Button variant={x ? 'quiet' : 'danger'} /><Button variant="primary" />`)).toEqual([]);
  });

  it('leaves another part’s own names alone (a Badge has its own framed look)', () => {
    expect(legacyNamesIn(`<Badge variant="${framed}">x</Badge><ButtonGroup variant="${quiet}" />`)).toEqual([]);
  });

  it('the owner’s paths are exactly the storefront ones', () => {
    for (const rel of [
      'src/components/landing/HtmlPromptButtons.tsx',
      'src/components/landing-editor/BlockBuilder.tsx',
      'src/components/landing-flow/CreateWizard.tsx',
      'src/components/screens/LandingPageEditorScreen.tsx',
      'src/components/screens/LandingPagesScreen.tsx',
      'src/components/screens/StoreReviewsScreen.tsx',
      'src/app/s/[slug]/page.tsx',
    ]) {
      expect(isOwner(rel), rel).toBe(true);
    }
    for (const rel of [
      'src/components/screens/OrdersScreen.tsx',
      'src/components/screens/TrackingScreen.tsx',
      'src/components/ui/Button.tsx',
      'src/app/(dashboard)/orders/page.tsx',
      'src/components/screens/LandingLane.tsx',
    ]) {
      expect(isOwner(rel), rel).toBe(false);
    }
  });
});
