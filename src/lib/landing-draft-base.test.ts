import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TWO WINDOWS ON ONE PAGE MUST NOT ERASE EACH OTHER.
 *
 * Each window opens on the page with a fingerprint (`base`, an md5 the
 * database computes) and hands it back with its save and its publish. The
 * statement writes only where the row still has that fingerprint; a window
 * that is behind gets «false»/`ok: false` and the route answers 409.
 *
 * Like `landing-draft.test.ts` this proves the SHAPE of the statements (the
 * guard sits in the WHERE of the same single statement, the choice between
 * draft and live is read from the row inside it) and the answers they give
 * for a row that was or was not found. What it cannot prove — that Postgres
 * evaluates the md5 against the row it is about to change — is the
 * single-statement guarantee the file header already relies on.
 */

const { db } = vi.hoisted(() => ({
  db: { $executeRawUnsafe: vi.fn(), $queryRawUnsafe: vi.fn() },
}));
vi.mock('./db', () => ({ db }));

import {
  CONTENT_FIELDS,
  PAGE_BASE_PATTERN,
  draftState,
  publishContent,
  saveContent,
  saveContentIfBase,
} from './landing-draft';

const BASE = 'a'.repeat(32);
const sqlOf = (mock: ReturnType<typeof vi.fn>) => (mock.mock.calls.at(-1)![0] as string).replace(/\s+/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
  db.$executeRawUnsafe.mockResolvedValue(1);
  db.$queryRawUnsafe.mockResolvedValue([]);
});

describe('the fingerprint', () => {
  it('is an md5 of what the editor opens on: the draft, else the live columns', async () => {
    db.$queryRawUnsafe.mockResolvedValue([
      { contentDraft: null, contentPrevious: null, contentPublishedAt: null, base: BASE },
    ]);
    const state = await draftState('lp1');
    expect(state.base).toBe(BASE);
    const sql = sqlOf(db.$queryRawUnsafe);
    expect(sql).toContain('md5(COALESCE("contentDraft", jsonb_build_object(');
    for (const f of CONTENT_FIELDS) expect(sql, f).toContain(`'${f}', "${f}"`);
  });

  it('only a 32-character md5 is accepted from a window', () => {
    expect(PAGE_BASE_PATTERN.test(BASE)).toBe(true);
    for (const bad of ['', 'x', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), "a'; DROP TABLE x;--"]) {
      expect(PAGE_BASE_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('NEGATIVE: a page that is not there has no base and does not throw', async () => {
    db.$queryRawUnsafe.mockResolvedValue([]);
    expect((await draftState('nope')).base).toBeUndefined();
  });
});

describe('saving with a base', () => {
  const saved = (over: Record<string, unknown> = {}) =>
    db.$queryRawUnsafe.mockResolvedValue([{ isPublished: true, base: 'b'.repeat(32), ...over }]);

  it('is ONE statement, and the guard is in its WHERE', async () => {
    saved();
    await saveContentIfBase('lp1', { sections: '[]' }, BASE);
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    const sql = sqlOf(db.$queryRawUnsafe);
    expect(sql).toMatch(/WHERE "id" = \$1 AND md5\(COALESCE\("contentDraft"/);
    expect(sql).toContain('RETURNING "isPublished"');
    const args = db.$queryRawUnsafe.mock.calls.at(-1)!;
    // id, the draft patch, the one field's value, then the base — in that order.
    expect(args[1]).toBe('lp1');
    expect(JSON.parse(args[2] as string)).toEqual({ sections: '[]' });
    expect(args[3]).toBe('[]');
    expect(args[4]).toBe(BASE);
    expect(sql).toContain('= $4 RETURNING');
  });

  it('decides draft or live INSIDE the statement, from the row’s own isPublished', async () => {
    saved();
    await saveContentIfBase('lp1', { htmlContent: '<p>x</p>', cssContent: null }, BASE);
    const sql = sqlOf(db.$queryRawUnsafe);
    // A live column is kept when the row is published, written when it is not…
    expect(sql).toContain('"htmlContent" = CASE WHEN "isPublished" THEN "htmlContent" ELSE $3::text END');
    expect(sql).toContain('"cssContent" = CASE WHEN "isPublished" THEN "cssContent" ELSE $4::text END');
    // …and the draft is merged when published, cleared when not.
    expect(sql).toContain('"contentDraft" = CASE WHEN "isPublished" THEN (COALESCE("contentDraft"::jsonb');
    expect(sql).toContain('ELSE NULL END');
    // The stale argument of the old door does not exist here at all.
    expect(saveContentIfBase.length).toBe(3);
  });

  it('answers where it landed and the new fingerprint', async () => {
    saved({ isPublished: true });
    expect(await saveContentIfBase('lp1', { sections: '[]' }, BASE)).toEqual({
      ok: true,
      wroteDraft: true,
      base: 'b'.repeat(32),
    });
    saved({ isPublished: false });
    expect(await saveContentIfBase('lp1', { sections: '[]' }, BASE)).toMatchObject({ ok: true, wroteDraft: false });
  });

  it('NEGATIVE: a window that is behind finds no row and writes nothing', async () => {
    db.$queryRawUnsafe.mockResolvedValue([]);
    expect(await saveContentIfBase('lp1', { sections: '[]' }, 'c'.repeat(32))).toEqual({ ok: false });
  });

  it('an empty patch still tells a stale window it is stale, and writes nothing', async () => {
    db.$queryRawUnsafe.mockResolvedValue([]);
    expect(await saveContentIfBase('lp1', {}, BASE)).toEqual({ ok: false });
    const sql = sqlOf(db.$queryRawUnsafe);
    expect(sql).toMatch(/^SELECT/);
    expect(sql).not.toContain('UPDATE');

    saved();
    expect(await saveContentIfBase('lp1', {}, BASE)).toMatchObject({ ok: true });
  });

  it('OLD WINDOW: saveContent without a base is the statement it always was', async () => {
    await saveContent('lp1', { sections: '[]' }, true);
    const sql = sqlOf(db.$executeRawUnsafe);
    expect(sql).not.toContain('md5');
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('publishing with a base', () => {
  it('adds the guard to the same single statement', async () => {
    await publishContent('lp1', BASE);
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const call = db.$executeRawUnsafe.mock.calls[0]!;
    expect((call[0] as string).replace(/\s+/g, ' ')).toMatch(/WHERE "id" = \$1 AND md5\(COALESCE\("contentDraft"/);
    expect(call[1]).toBe('lp1');
    expect(call[2]).toBe(BASE);
  });

  it('is refused (false) when no row matched: nothing was published', async () => {
    db.$executeRawUnsafe.mockResolvedValue(0);
    expect(await publishContent('lp1', BASE)).toBe(false);
  });

  it('publishes (true) when the page is still the one the window read', async () => {
    db.$executeRawUnsafe.mockResolvedValue(1);
    expect(await publishContent('lp1', BASE)).toBe(true);
  });

  it('OLD WINDOW: with no base it never refuses and its statement has no md5', async () => {
    // Even if the driver reports zero rows: the old press is unconditional.
    db.$executeRawUnsafe.mockResolvedValue(0);
    expect(await publishContent('lp1')).toBe(true);
    const call = db.$executeRawUnsafe.mock.calls[0]!;
    expect(call[0] as string).not.toContain('md5');
    expect(call).toHaveLength(2);
  });
});
