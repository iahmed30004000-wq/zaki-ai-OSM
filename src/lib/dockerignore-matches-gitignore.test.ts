import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT GIT KEEPS PRIVATE, DOCKER MUST KEEP PRIVATE TOO.
 *
 * `.gitignore` hides the handover reports, the local backups, the licensed
 * fonts and the scratch scripts from the (public) repository. `.dockerignore`
 * is a separate file with a separate job, and it did not list any of them:
 * a `docker build .` on a working machine sent the whole directory, and
 * `.next/standalone` traced `HANDOVER-*.md` and `tmp-*.mjs` into the image.
 * CI and Coolify build from clean checkouts and never had the files, which
 * is exactly why nobody noticed.
 * ═══════════════════════════════════════════════════════════════════════
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** The meaningful lines of an ignore file: no comments, no blanks. */
const patterns = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

/** `/a/`, `a/` and `a` all name the same directory for this comparison. */
const bare = (p: string) => p.replace(/^\/+/, '').replace(/\/+$/, '');

/** What `.dockerignore` must carry, and the reason each is private. */
const MUST_BE_IGNORED = [
  'HANDOVER-*.md', // the hand-over reports
  'tmp*.mjs', // scratch scripts (the ones that wipe or rewrite a database)
  'tmp*.cjs',
  'backups/', // local database dumps
  'fonts-local/', // fonts licensed for one machine only
  '.claude/', // agent worktrees and settings
  '.next-verify/', // builds made to verify
  '.next-measure/', // builds made to measure
  '**/*.local.json', // e.g. scripts/migration/migration-report.local.json
];

/** The entries of `have` that `want` asks for and it lacks. */
function missing(have: string, want: string[]): string[] {
  const got = new Set(patterns(have).map(bare));
  return want.filter((w) => !got.has(bare(w)));
}

describe('.dockerignore keeps the private files out of the build context', () => {
  const docker = read('.dockerignore');

  it('lists every private pattern', () => {
    expect(missing(docker, MUST_BE_IGNORED)).toEqual([]);
  });

  it('the check fails when a pattern is taken out (so it is not vacuous)', () => {
    for (const w of MUST_BE_IGNORED) {
      const without = patterns(docker)
        .filter((l) => bare(l) !== bare(w))
        .join('\n');
      expect(missing(without, MUST_BE_IGNORED), w).toEqual([w]);
    }
    // And an empty file is missing all of them.
    expect(missing('', MUST_BE_IGNORED)).toHaveLength(MUST_BE_IGNORED.length);
  });

  it('still keeps the secrets and the dependencies out, and still lets the example env through', () => {
    const got = patterns(docker);
    for (const p of ['.env', '.env.*', '!.env.example', 'node_modules', '.git', '.next']) {
      expect(got, p).toContain(p);
    }
  });
});

describe('and it does not drift from .gitignore', () => {
  const git = patterns(read('.gitignore'));
  const docker = read('.dockerignore');

  // The word in the entry is what marks it private; build output and caches
  // are a different (and already covered) matter.
  const PRIVATE_WORDS = /HANDOVER|backups|fonts-local|tmp\*|next-verify|next-measure|\.claude\//;

  it('every private entry git ignores is ignored by docker as well', () => {
    const privateInGit = git.filter((l) => PRIVATE_WORDS.test(l));
    // Guard against the filter matching nothing and passing for the wrong reason.
    expect(privateInGit.length).toBeGreaterThanOrEqual(7);

    const want = privateInGit.map((l) => (l.startsWith('/.claude/') ? '.claude/' : l));
    expect(missing(docker, want)).toEqual([]);
  });

  it('every *.local.json that a nested .gitignore hides is covered by the glob', () => {
    const nested = patterns(read('scripts/migration/.gitignore')).filter((l) => l.endsWith('.local.json'));
    expect(nested.length).toBeGreaterThan(0);
    expect(patterns(docker)).toContain('**/*.local.json');
  });
});
