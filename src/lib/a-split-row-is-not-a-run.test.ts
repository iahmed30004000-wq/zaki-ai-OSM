import { describe, expect, it } from 'vitest';
import { countRuns, foldSplitRows, runOfRows } from './batch-grade';
import { placesOf, shownPlaces } from './stock-places';

/**
 * A ROW SPLIT OFF A RUN IS NOT A RUN, AND THE PLACES ADD UP TO THE SHELF (the warehouse plan, W2c).
 *
 * The pure halves of the stock screens' new reading: `batch-grade.foldSplitRows` / `countRuns` (a twin is listed and
 * counted with its run) and `stock-places.placesOf` / `shownPlaces` (the units of a product by place). Every expected
 * figure below is written out by hand, never computed with the function under test.
 */

const row = (id: string, sold: number, remaining: number, splitFromBatchId: string | null = null) => ({
  id,
  splitFromBatchId,
  quantityProduced: splitFromBatchId ? 0 : 10,
  quantitySold: sold,
  quantityRemaining: remaining,
});

describe('foldSplitRows', () => {
  it('no twin: the very rows, the same objects, in the same order', () => {
    const rows = [row('a', 1, 2), row('b', 3, 4)];
    const out = foldSplitRows(rows);
    expect(out).toEqual(rows);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).toBe(rows[1]);
  });

  it('a twin and a twin of a twin are folded into their run: sold and remaining carried, produced the run’s own', () => {
    const rows = [row('run', 2, 3), row('t1', 1, 4, 'run'), row('t2', 0, 5, 't1'), row('other', 0, 7)];
    expect(foldSplitRows(rows)).toEqual([
      { id: 'run', splitFromBatchId: null, quantityProduced: 10, quantitySold: 3, quantityRemaining: 12 },
      row('other', 0, 7),
    ]);
  });

  it('twins handed separately (the product page reads them apart) fold the same, and a twin listed twice counts once', () => {
    const runs = [row('run', 2, 3)];
    const twins = [row('t1', 1, 4, 'run'), row('t1', 1, 4, 'run')];
    expect(foldSplitRows(runs, twins)).toEqual([{ ...row('run', 3, 7), quantityProduced: 10 }]);
  });

  it('a twin whose run is not among the rows (deleted, or out of the list) stands as its own row, untouched', () => {
    const rows = [row('t1', 1, 4, 'gone')];
    expect(foldSplitRows(rows)).toEqual([row('t1', 1, 4, 'gone')]);
  });

  it('NEGATIVE: a twin of a run outside the list is NOT added to a run inside it', () => {
    const rows = [row('run', 0, 3)];
    expect(foldSplitRows(rows, [row('t9', 0, 50, 'elsewhere')])).toEqual([row('run', 0, 3)]);
  });
});

describe('countRuns and runOfRows', () => {
  it('rows of one run count once; a chain resolves to its top', () => {
    const rows = [row('a', 0, 1), row('a1', 0, 1, 'a'), row('a2', 0, 1, 'a1'), row('b', 0, 1)];
    expect(countRuns(rows)).toBe(2);
    expect(runOfRows(rows)(rows[2])).toBe('a');
  });

  it('counting some rows against all of them: two twins of one run are one run', () => {
    const rows = [row('a', 0, 0), row('a1', 0, 1, 'a'), row('a2', 0, 1, 'a'), row('b', 0, 1)];
    expect(countRuns(rows, [rows[1], rows[2]])).toBe(1);
    expect(countRuns(rows, [])).toBe(0);
  });

  it('NEGATIVE: with no twin, every row is its own run (the count of rows)', () => {
    expect(countRuns([row('a', 0, 1), row('b', 0, 1), row('c', 0, 0)])).toBe(3);
  });

  it('a cycle in bad data ends instead of looping', () => {
    const rows = [row('x', 0, 1, 'y'), row('y', 0, 1, 'x')];
    expect(countRuns(rows)).toBeGreaterThan(0);
  });
});

describe('placesOf and shownPlaces', () => {
  const rows = [
    { quantityRemaining: 4, warehouseId: 'w2' },
    { quantityRemaining: 3, warehouseId: 'w1' },
    { quantityRemaining: 2, warehouseId: 'w1' },
    { quantityRemaining: 5, warehouseId: null, inTransitTransferId: 't' },
    { quantityRemaining: 1, warehouseId: null, inTransitTransferId: null },
    { quantityRemaining: 0, warehouseId: 'w3' },
    { quantityRemaining: 6, warehouseId: 'w9' },
  ];

  it('per warehouse in the order given, then any other a row names; zeros left out; road and no-place apart', () => {
    expect(placesOf(rows, ['w1', 'w2', 'w3'])).toEqual({
      warehouses: [
        { id: 'w1', onHand: 5 },
        { id: 'w2', onHand: 4 },
        { id: 'w9', onHand: 6 },
      ],
      inTransit: 5,
      unplaced: 1,
    });
  });

  it('no row at all: nothing anywhere', () => {
    expect(placesOf([], ['w1'])).toEqual({ warehouses: [], inTransit: 0, unplaced: 0 });
  });

  it('«بلا مكان» is sent only when it is not the courier figure', () => {
    const p = placesOf(rows, ['w1']);
    expect(shownPlaces(p, 1)).toEqual({ warehouses: p.warehouses, inTransit: 5, withCourier: 1 });
    expect(shownPlaces(p, 0)).toEqual({ warehouses: p.warehouses, inTransit: 5, withCourier: 0, unplaced: 1 });
  });

  it('NEGATIVE: a negative row (the shelf owes units) is not hidden as a zero', () => {
    expect(placesOf([{ quantityRemaining: -2, warehouseId: 'w1' }], ['w1']).warehouses).toEqual([{ id: 'w1', onHand: -2 }]);
  });
});
