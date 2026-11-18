import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BASELINE_PATH, EXTRA_KINDS, KINDS, inventory, type Counts } from '../../scripts/ui-inventory';

/**
 * THE PROMISE A RESTYLE MAKES.
 *
 * Only the looks change. No button gained, no column lost, no field quietly
 * folded into its neighbour, no icon dropped because the new spacing made
 * the row feel crowded. That promise is normally kept by somebody scrolling
 * through the diff, which works up to about the fortieth file.
 *
 * So it is counted. If a restyle removes a column, this fails and names the
 * file, before a browser is opened and long before somebody in a warehouse
 * notices the quantity is gone.
 *
 * WHEN A CHANGE IS INTENDED — a real feature, adding a screen or a field —
 * the baseline is rewritten deliberately:
 *
 *   npx tsx scripts/ui-inventory.ts --write
 *
 * and the new numbers go in the same commit as the feature. That is the
 * point: a change to this file is a change somebody had to mean.
 */

type Baseline = Record<string, Partial<Counts>>;

const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const now = inventory();

describe('what is on the screens', () => {
  it('has not lost a file', () => {
    const gone = Object.keys(baseline).filter((f) => !(f in now));
    expect(gone, `شاشات اختفت:\n${gone.join('\n')}`).toEqual([]);
  });

  it('and any new file was added on purpose, not noticed later', () => {
    const extra = Object.keys(now).filter((f) => !(f in baseline));
    expect(
      extra,
      `ملفات جديدة بلا تحديث للأساس — شغّل: npx tsx scripts/ui-inventory.ts --write\n${extra.join('\n')}`
    ).toEqual([]);
  });

  it.each(KINDS)('has the same number of %s, file by file', (kind) => {
    const moved: string[] = [];
    for (const [file, counts] of Object.entries(baseline)) {
      const after = now[file];
      if (!after) continue; // named by the test above
      if (after[kind] !== counts[kind]) moved.push(`${file}: ${counts[kind]} → ${after[kind]}`);
    }
    expect(moved, `تغيّر عدد «${kind}»:\n${moved.join('\n')}`).toEqual([]);
  });
});

/**
 * THE THREE KIT TAGS OF THE RESTRUCTURE (18/11, R0).
 *
 * `<IconButton`, `<Checkbox` and `<Switch` do not exist yet, so the baseline carries no key for them and a missing key reads
 * as zero. The day a screen draws one, `--write` records it; from then a restyle that deletes it is named here like a deleted column.
 */
describe('the kit tags that arrive with the restructure', () => {
  it.each(EXTRA_KINDS)('has the same number of %s, file by file (a missing key is zero)', (kind) => {
    const moved: string[] = [];
    for (const file of new Set([...Object.keys(baseline), ...Object.keys(now)])) {
      const before = baseline[file]?.[kind] ?? 0;
      const after = now[file]?.[kind] ?? 0;
      if (before !== after) moved.push(`${file}: ${before} → ${after}`);
    }
    expect(moved, `تغيّر عدد «${kind}» — إن كان مقصوداً شغّل: npx tsx scripts/ui-inventory.ts --write\n${moved.join('\n')}`).toEqual([]);
  });
});

/**
 * The baseline is only worth anything if it is actually counting. A
 * regression that made every count zero would pass every test above.
 */
describe('the count itself', () => {
  it('sees the screens, not an empty list', () => {
    expect(Object.keys(now).length).toBeGreaterThan(100);
  });

  it('and counts every kind it claims to', () => {
    for (const kind of KINDS) {
      const total = Object.values(now).reduce((s, c) => s + c[kind], 0);
      expect(total, `«${kind}» لا يُعدّ إطلاقاً`).toBeGreaterThan(0);
    }
  });
});
