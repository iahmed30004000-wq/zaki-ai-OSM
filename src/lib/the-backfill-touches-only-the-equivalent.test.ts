import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from './guard-source';

/**
 * «عبّي السعر للقديم بسعر اليوم» (23/11, F8) — THE ONE KNOWING EXCEPTION TO «A WRITTEN MOVEMENT IS NEVER EDITED».
 *
 * `money-moves-at-two-doors.test.ts` holds that `wallets.ts` never updates a movement. The owner's exception edits old draws'
 * EQUIVALENT, and only that: this file pins that `lib/draw-backfill.ts` is the only source that updates a wallet movement, and that
 * every field it writes is one of the five of the equivalent — never the amount, the wallet, the direction, the partner or a date.
 */

const SRC = join(process.cwd(), 'src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) && !p.includes('.test.') ? [p] : [];
  });
const rel = (p: string) => relative(process.cwd(), p).split(sep).join('/');
const ALLOWED_FIELDS = new Set(['valueInStoreCurrency', 'equivalentRate', 'equivalentRateKind', 'equivalentRateSource', 'equivalentRateAt']);

describe('the only edit of a written movement', () => {
  it('is in lib/draw-backfill.ts and nowhere else', () => {
    const editors = files(SRC)
      .filter((p) => /walletMovement\.(update|updateMany|upsert)\(/.test(stripComments(readFileSync(p, 'utf8'))))
      .map(rel);
    expect(editors).toEqual(['src/lib/draw-backfill.ts']);
  });

  it('and writes only the five fields of the equivalent', () => {
    const src = stripComments(readFileSync(join(SRC, 'lib/draw-backfill.ts'), 'utf8'));
    // The keys that appear in a `data:` object are the equivalent's; the others appear only in a WHERE or a select.
    const dataBlocks = [...src.matchAll(/data(?::|\s*=)\s*[\s\S]*?(?:\}\s*\);|\};)/g)].map((m) => m[0]);
    const dataKeys = new Set(dataBlocks.flatMap((b) => [...b.matchAll(/\b([A-Za-z]+):/g)].map((m) => m[1])).filter((k) => k !== 'data'));
    expect(dataKeys.size, [...dataKeys].join()).toBe(5);
    for (const k of dataKeys) expect(ALLOWED_FIELDS.has(k), k).toBe(true);
  });
});
