/**
 * COUNTING WHAT IS ON THE SCREENS, SO A RESTYLE CAN BE PROVED NOT TO CHANGE IT.
 *
 * A visual migration has exactly one promise: nothing moves except how it
 * looks. No button gained, no column lost, no field quietly merged into its
 * neighbour. That promise is usually kept by a person scrolling through a
 * diff, which works until the diff is four hundred files long.
 *
 * So it is counted instead. This walks every screen and component, counts
 * the things the promise is about, and writes one number per kind per file.
 * The baseline is committed; the test beside it re-counts and compares. A
 * restyle that deletes a column fails, in the name of the file it deleted
 * it from, before anybody opens a browser.
 *
 * WHAT IT IS NOT. It is not a parser, and it does not know React. It counts
 * occurrences in source text, which is crude and exactly right for the job:
 * the question is never "how many buttons render at runtime" — that depends
 * on data and permissions — but "did this edit remove one from the source".
 *
 *   npx tsx scripts/ui-inventory.ts          # print the summary
 *   npx tsx scripts/ui-inventory.ts --write  # rewrite the baseline
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Where the screens live. Landing and storefront are a customer's design, not ours. */
const SCAN = ['src/components', 'src/app'];
const SKIP = ['/components/landing/', '/components/public/', '/components/store/', '/app/(public)/', '/app/lp/', '/app/s/'];

export interface Counts {
  buttons: number;
  inputs: number;
  columns: number;
  cards: number;
  modals: number;
  icons: number;
  links: number;
  tabs: number;
  /** The three kit tags of the restructure (R2). They did not exist when this census was written, so a file that has none carries no key for them. */
  iconButtons: number;
  checkboxes: number;
  switches: number;
}

export const KINDS = ['buttons', 'inputs', 'columns', 'cards', 'modals', 'icons', 'links', 'tabs'] as const;

/**
 * KINDS THAT ARE NOT IN THE BASELINE UNTIL A SCREEN DRAWS THEM (18/11, R0).
 *
 * `<IconButton`, `<Checkbox` and `<Switch` are kit components the restructure adds. Counting them from today means a later
 * restyle that deletes one is caught like a deleted column — and because no screen draws them yet, every file counts zero,
 * so the baseline file stays as it is and `ui-inventory.test.ts` stays green WITHOUT `--write`. A zero is never written;
 * a missing key reads as zero.
 */
export const EXTRA_KINDS = ['iconButtons', 'checkboxes', 'switches'] as const;

/**
 * The icons in use, by name, so a renamed import is not mistaken for a
 * deleted icon and an added one is not mistaken for a rename. Both families
 * are read: the dashboard is Remix, and a seller's own pages are not this
 * migration's business.
 */
const ICON_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'(?:@remixicon\/react|lucide-react)'/g;

function countIcons(src: string): number {
  let total = 0;
  for (const m of src.matchAll(ICON_IMPORT)) {
    const names = m[1]
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const name of names) {
      // Every place the icon is actually drawn, not the import line.
      total += (src.match(new RegExp(`<${name}[\\s/>]`, 'g')) ?? []).length;
    }
  }
  return total;
}

function count(src: string): Counts {
  const n = (re: RegExp) => (src.match(re) ?? []).length;
  return {
    buttons: n(/<button[\s>]/g) + n(/<Button[\s>]/g),
    /*
     * A field is a field whether it is a text box, a dropdown or a tick.
     *
     * `<Textarea>` WAS MISSING and the lowercase `<textarea>` beside it was
     * not: both spellings are in use, and the capitalised one — the shared
     * component almost every dialog reaches for — counted as nothing.
     * MEASURED when it was added: **16 fields across 9 files** that this
     * census said were not there. A dialog built out of the component this
     * repository actually provides registered as having no inputs at all,
     * which is the one thing a census exists to notice.
     */
    inputs:
      n(/<input[\s>]/g) +
      n(/<Input[\s>]/g) +
      n(/<textarea[\s>]/g) +
      n(/<Textarea[\s>]/g) +
      n(/<Select[\s>]/g) +
      n(/<select[\s>]/g),
    // A table heading, or a column described once for `Rows` to draw twice.
    columns: n(/<th[\s>]/g) + n(/^\s*\{\s*key:\s*'/gm),
    cards: n(/<Card[\s>]/g),
    modals: n(/<Modal[\s>]/g),
    icons: countIcons(src),
    /*
     * `<Link>` AND A PLAIN ANCHOR. 37 anchors across 20 files were invisible
     * here, including every «اذهب إلى» a screen writes without reaching for
     * next/link. The `href` is required rather than matching `<a[\s>]`: the
     * looser form also matched the word «<a>» inside a COMMENT, and a census
     * that counts prose is worse than one that counts nothing.
     */
    links: n(/<Link[\s>]/g) + n(/<a\s+[^>]*href/g),
    tabs: n(/role="tab"/g),
    // `[\s/>]` and not `[\s>]` like the older kinds: the new tags are mostly written self-closing, `<Checkbox/>`.
    iconButtons: n(/<IconButton[\s/>]/g),
    checkboxes: n(/<Checkbox[\s/>]/g),
    switches: n(/<Switch[\s/>]/g),
  };
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * EVERY SCREEN FILE THIS CENSUS LOOKS AT — repo-relative, forward slashes, sorted.
 *
 * Exported so `scripts/ui-debt.ts` walks the SAME files and applies the SAME skips instead of keeping a second list that
 * would drift from this one.
 */
export function uiFilePaths(): string[] {
  const out: string[] = [];
  for (const base of SCAN) {
    for (const file of files(join(ROOT, base))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (SKIP.some((s) => `/${rel}`.includes(s))) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

export function inventory(): Record<string, Counts> {
  const result: Record<string, Counts> = {};
  for (const rel of uiFilePaths()) {
    // CRLF or LF, the same numbers: a checkout on Windows must not disagree with CI.
    const counts = count(readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'));
    // A file with nothing to count is a file this promise says nothing
    // about; listing it would be noise that has to be maintained.
    if ([...KINDS, ...EXTRA_KINDS].every((k) => counts[k] === 0)) continue;
    result[rel] = counts;
  }
  return result;
}

/** What goes into the baseline file: the extra kinds only where they are above zero. */
export function forBaseline(now: Record<string, Counts>): Record<string, Partial<Counts>> {
  const out: Record<string, Partial<Counts>> = {};
  for (const [file, counts] of Object.entries(now)) {
    const row: Partial<Counts> = { ...counts };
    for (const k of EXTRA_KINDS) if (row[k] === 0) delete row[k];
    out[file] = row;
  }
  return out;
}

export const BASELINE_PATH = join(ROOT, 'scripts', 'ui-inventory.json');

if (process.argv[1] && process.argv[1].includes('ui-inventory')) {
  const now = inventory();
  const totals = [...KINDS, ...EXTRA_KINDS].reduce(
    (acc, k) => ({ ...acc, [k]: Object.values(now).reduce((s, c) => s + c[k], 0) }),
    {} as Counts
  );
  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(forBaseline(now), null, 2)}\n`, 'utf8');
    console.log(`baseline written: ${Object.keys(now).length} files`);
  }
  console.log(`${Object.keys(now).length} files`);
  for (const k of [...KINDS, ...EXTRA_KINDS]) console.log(`  ${k.padEnd(12)} ${totals[k]}`);
}
