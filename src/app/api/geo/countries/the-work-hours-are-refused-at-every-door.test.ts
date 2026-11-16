import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EVERY DOOR THAT WRITES A COUNTRY'S WORKING DAY SAYS NO TO A NIGHT SHIFT.
 *
 * Planner ruling 18: no night shift. The doors are POST /api/geo/countries
 * (create) and PATCH /api/geo/countries/:id (update) — the only code in src
 * that writes Country.workHoursStart/End (the seed relies on the column
 * defaults, 09:00-17:00).
 *
 * DoD: see work-hours.test.ts. Here — the same refusal at both doors, with
 * the project's error shape ({ error }, 400), nothing written on a refusal,
 * a lone half judged against the stored row, and a save that does not touch
 * the hours passing even on a stored night-shift row.
 */

const { db } = vi.hoisted(() => ({
  db: { country: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }, order: { count: vi.fn() } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ user: { id: 'u1' }, companyId: 'co1' }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/geo-context', () => ({ geoReach: async () => null }));

import { POST } from './route';
import { PATCH } from './[id]/route';
import { WORK_HOURS_FORMAT_MESSAGE, WORK_HOURS_ORDER_MESSAGE } from '@/lib/work-hours';

const base = { code: 'sy', name: 'سوريا', currencyCode: 'syp', minorUnit: 2 };
const post = (body: unknown) => POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }));
const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'k1' }) });

/** The stored row — a day (09:00-17:00) unless a test stores something else. */
let stored: { workHoursStart: string; workHoursEnd: string };

beforeEach(() => {
  vi.clearAllMocks();
  stored = { workHoursStart: '09:00', workHoursEnd: '17:00' };
  db.country.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.id === 'k1' ? { id: 'k1', code: 'SY', currencyCode: 'SYP', minorUnit: 2, name: 'سوريا', weekendDays: [5], ...stored } : null
  );
  db.country.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'new', ...data }));
  db.country.update.mockImplementation(async ({ data }: { data: object }) => ({ id: 'k1', ...data }));
});

async function refusedWith(res: Response, message: string) {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: message });
}

describe('POST /api/geo/countries — create', () => {
  it('without hours takes the 09:00-17:00 defaults and is created', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(db.country.create.mock.calls[0][0].data).toMatchObject({ workHoursStart: '09:00', workHoursEnd: '17:00' });
  });

  it('a Syrian day (10:00-22:00) and a full day (00:00-23:59) are created', async () => {
    expect((await post({ ...base, workHoursStart: '10:00', workHoursEnd: '22:00' })).status).toBe(201);
    expect((await post({ ...base, workHoursStart: '00:00', workHoursEnd: '23:59' })).status).toBe(201);
  });

  it('refuses a reversed day, an equal one, and a lone half that crosses the default — writing nothing', async () => {
    await refusedWith(await post({ ...base, workHoursStart: '22:00', workHoursEnd: '06:00' }), WORK_HOURS_ORDER_MESSAGE);
    await refusedWith(await post({ ...base, workHoursStart: '09:00', workHoursEnd: '09:00' }), WORK_HOURS_ORDER_MESSAGE);
    // start alone, after the default end 17:00; end alone, before the default start 09:00
    await refusedWith(await post({ ...base, workHoursStart: '18:00' }), WORK_HOURS_ORDER_MESSAGE);
    await refusedWith(await post({ ...base, workHoursEnd: '08:00' }), WORK_HOURS_ORDER_MESSAGE);
    expect(db.country.create).not.toHaveBeenCalled();
  });

  it('refuses a corrupt value with the format message', async () => {
    for (const bad of ['24:00', '9:00', '09:60', '', 'abc', 900]) {
      await refusedWith(await post({ ...base, workHoursEnd: bad }), WORK_HOURS_FORMAT_MESSAGE);
    }
    expect(db.country.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/geo/countries/:id — update', () => {
  it('takes a valid pair and writes exactly what was sent', async () => {
    const res = await patch({ workHoursStart: '10:00', workHoursEnd: '22:00' });
    expect(res.status).toBe(200);
    expect(db.country.update.mock.calls[0][0].data).toEqual({ workHoursStart: '10:00', workHoursEnd: '22:00' });
  });

  it('refuses a reversed pair and an equal pair — writing nothing', async () => {
    await refusedWith(await patch({ workHoursStart: '22:00', workHoursEnd: '06:00' }), WORK_HOURS_ORDER_MESSAGE);
    await refusedWith(await patch({ workHoursStart: '09:00', workHoursEnd: '09:00' }), WORK_HOURS_ORDER_MESSAGE);
    expect(db.country.update).not.toHaveBeenCalled();
  });

  it('judges a lone end against the STORED start, and a lone start against the stored end', async () => {
    await refusedWith(await patch({ workHoursEnd: '08:00' }), WORK_HOURS_ORDER_MESSAGE); // stored start 09:00
    await refusedWith(await patch({ workHoursEnd: '09:00' }), WORK_HOURS_ORDER_MESSAGE); // equal to stored start
    await refusedWith(await patch({ workHoursStart: '18:00' }), WORK_HOURS_ORDER_MESSAGE); // stored end 17:00
    expect(db.country.update).not.toHaveBeenCalled();

    expect((await patch({ workHoursEnd: '22:00' })).status).toBe(200);
    expect((await patch({ workHoursStart: '08:00' })).status).toBe(200);
    expect(db.country.update).toHaveBeenCalledTimes(2);
  });

  it('refuses a corrupt value with the format message (the schema, in the same shape)', async () => {
    for (const bad of ['24:00', '9:00', '09:60', '', 'abc', 900, null]) {
      await refusedWith(await patch({ workHoursStart: bad }), WORK_HOURS_FORMAT_MESSAGE);
    }
    expect(db.country.update).not.toHaveBeenCalled();
  });

  it('a lone half that makes a stored night row a day is the way out — one edit is enough', async () => {
    stored = { workHoursStart: '22:00', workHoursEnd: '06:00' };
    expect((await patch({ workHoursEnd: '23:00' })).status).toBe(200); // 22:00-23:00
    expect((await patch({ workHoursStart: '05:00' })).status).toBe(200); // 05:00-06:00
    // but a lone edit that leaves it a night shift is still refused
    await refusedWith(await patch({ workHoursEnd: '07:00' }), WORK_HOURS_ORDER_MESSAGE); // 22:00-07:00
  });

  it('a save that does not touch the hours passes on a stored night-shift row', async () => {
    stored = { workHoursStart: '22:00', workHoursEnd: '06:00' };
    for (const body of [{ name: 'سورية' }, { weekendDays: [5, 6] }, { orderPrefix: 'SY' }, { isActive: false }, { timezone: 'Asia/Damascus' }, {}]) {
      const res = await patch(body);
      expect(res.status).toBe(200);
    }
    // and nothing about the hours was written by them
    for (const [call] of db.country.update.mock.calls) {
      expect(call.data).not.toHaveProperty('workHoursStart');
      expect(call.data).not.toHaveProperty('workHoursEnd');
    }
  });

  it('a corrupt STORED value is refused only when the request touches the hours', async () => {
    stored = { workHoursStart: 'garbage', workHoursEnd: '17:00' };
    expect((await patch({ name: 'سورية' })).status).toBe(200);
    await refusedWith(await patch({ workHoursEnd: '18:00' }), WORK_HOURS_FORMAT_MESSAGE);
    // sending both halves repairs it
    expect((await patch({ workHoursStart: '09:00', workHoursEnd: '18:00' })).status).toBe(200);
  });

  it('an unknown country is still 404, not a hours message', async () => {
    const res = await PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ workHoursStart: '22:00', workHoursEnd: '06:00' }) }), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
  });
});
