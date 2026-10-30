import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE FOLDER FOR THE COURIERS, ONE FOR THE PARCELS ON THE ROAD.
 *
 * `courier-*.ts` lay loose in `src/lib/` beside `couriers/`, and `tracking-*.ts`
 * (a parcel on the road) beside `tracking/` (an ad pixel) — one word, two
 * meanings. They moved into `couriers/` and `parcel-tracking/` with no change
 * to what they do. This keeps the flat names from growing back.
 */

const LIB = join(process.cwd(), 'src', 'lib');
const loose = readdirSync(LIB);

describe('src/lib has no loose courier or parcel-tracking file', () => {
  it('— nothing named courier-*', () => {
    expect(loose.filter((f) => /^courier-/.test(f) && !f.endsWith('.test.ts')), 'ملف شحن خارج couriers/').toEqual([]);
  });

  it('— nothing named tracking-*', () => {
    expect(loose.filter((f) => /^tracking-/.test(f) && !f.endsWith('.test.ts')), 'ملف تتبّع طرود خارج parcel-tracking/').toEqual([]);
  });

  it('— and the homes hold what moved (a move that lost a file fails here)', () => {
    const couriers = readdirSync(join(LIB, 'couriers'));
    for (const f of ['dispatch.ts', 'scope.ts', 'score.ts', 'words.ts', 'transfer.ts', 'remote-cancel.ts', 'places.ts', 'city-gaps.ts']) {
      expect(couriers, f).toContain(f);
    }
    const parcels = readdirSync(join(LIB, 'parcel-tracking'));
    for (const f of ['alert.ts', 'filters.ts', 'list.ts', 'priority.ts', 'sight.ts']) expect(parcels, f).toContain(f);
  });

  it('— and `ai-provider` is one folder with one public door', () => {
    expect(loose).not.toContain('ai-provider.ts');
    const files = readdirSync(join(LIB, 'ai-provider'));
    for (const f of ['index.ts', 'catalogue.ts', 'settings.ts', 'routing.ts', 'call.ts']) expect(files, f).toContain(f);
  });
});
