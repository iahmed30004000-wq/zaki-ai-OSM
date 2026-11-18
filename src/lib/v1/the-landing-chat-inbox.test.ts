import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * «رسائل اللاندينج» AT THE LANDING DOOR (contract oms-lp.v1 §11), answering — with the REAL key check, the REAL
 * idempotency ledger, the real relay and the real staff side, over an in-memory database. `the-systems-door.test.ts`
 * sweeps the two door routes for the key, the claim and the tenant; this file holds what they decide.
 */

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const state = {
    tokens: new Map<string, Row>(),
    idem: new Map<string, Row>(),
    threads: [] as Row[],
    lines: [] as Row[],
    orders: [] as Row[],
    notifications: [] as Row[],
    seq: 0,
    lineSeq: BigInt(0),
  };
  return { state, notify: vi.fn(), logAudit: vi.fn() };
});

vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => h.notify(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));

vi.mock('@/lib/db', () => {
  const s = h.state;
  const dup = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
  const pick = (row: Row | undefined, select?: Row): Row | null => {
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(
      Object.keys(select).map((k) => {
        if (k === 'thread') return [k, pick(s.threads.find((t) => t.id === row.threadId), select.thread.select)];
        return [k, row[k]];
      })
    );
  };
  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as Row)) row[k] = (row[k] ?? 0) + (v as Row).increment;
      else row[k] = v;
    }
    row.updatedAt = new Date();
  };
  const threadWhere = (t: Row, where: Row) =>
    (where.id === undefined || t.id === where.id) &&
    (where.companyId === undefined || t.companyId === where.companyId) &&
    (where.unreadCount?.gt === undefined || t.unreadCount > where.unreadCount.gt) &&
    (where.botPaused === undefined || t.botPaused === where.botPaused);
  const byKey = (where: Row) =>
    where.companyId_externalId
      ? s.threads.find((t) => t.companyId === where.companyId_externalId.companyId && t.externalId === where.companyId_externalId.externalId)
      : s.threads.find((t) => t.id === where.id);
  const lineWhere = (m: Row, where: Row) =>
    (where.companyId === undefined || m.companyId === where.companyId) &&
    (where.threadId === undefined || m.threadId === where.threadId) &&
    (where.direction === undefined || (typeof where.direction === 'string' ? m.direction === where.direction : where.direction.in.includes(m.direction))) &&
    (where.externalId?.in === undefined || where.externalId.in.includes(m.externalId)) &&
    (where.seq?.gt === undefined || m.seq > where.seq.gt) &&
    (where.createdAt?.lte === undefined || m.createdAt <= where.createdAt.lte);
  const newLine = (data: Row): Row => ({
    id: `m${++s.seq}`,
    seq: (s.lineSeq = s.lineSeq + BigInt(1)),
    externalId: null,
    text: null,
    event: null,
    authorId: null,
    authorName: null,
    sentAt: new Date(),
    createdAt: new Date(Date.now() - 10_000), // settled, unless a test says otherwise
    ...data,
  });
  const db: Row = {
    systemToken: {
      findUnique: vi.fn(async ({ where }: Row) => s.tokens.get(where.tokenHash) ?? null),
      update: vi.fn(async () => ({})),
    },
    idempotencyRecord: {
      create: vi.fn(async ({ data }: Row) => {
        const k = `${data.companyId}:${data.key}`;
        if (s.idem.has(k)) throw dup();
        s.idem.set(k, { ...data });
        return data;
      }),
      findUnique: vi.fn(async ({ where }: Row) => s.idem.get(`${where.companyId_key.companyId}:${where.companyId_key.key}`) ?? null),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = s.idem.get(`${where.companyId_key.companyId}:${where.companyId_key.key}`)!;
        Object.assign(row, data);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: Row) => {
        const k = `${where.companyId}:${where.key}`;
        if (s.idem.get(k)?.status === 0) s.idem.delete(k);
        return { count: 1 };
      }),
    },
    order: {
      findFirst: vi.fn(async ({ where }: Row) => {
        const o = s.orders.find((x) => x.companyId === where.companyId && x.orderNumber === where.orderNumber);
        return o ? { id: o.id } : null;
      }),
    },
    landingChatThread: {
      findUnique: vi.fn(async ({ where, select }: Row) => pick(byKey(where), select)),
      findFirst: vi.fn(async ({ where, select }: Row) => pick(s.threads.find((t) => threadWhere(t, where)), select)),
      findMany: vi.fn(async ({ where, select }: Row) => s.threads.filter((t) => threadWhere(t, where)).map((t) => pick(t, select))),
      count: vi.fn(async ({ where }: Row) => s.threads.filter((t) => threadWhere(t, where)).length),
      create: vi.fn(async ({ data, select }: Row) => {
        if (s.threads.some((t) => t.companyId === data.companyId && t.externalId === data.externalId)) throw dup();
        const row: Row = {
          id: `th${++s.seq}`,
          mode: 'confirm',
          pageId: null,
          pageSlug: null,
          pageName: null,
          pageUrl: null,
          productId: null,
          productName: null,
          orderNumber: null,
          orderId: null,
          customerName: null,
          customerPhone: null,
          botPaused: false,
          botPausedAt: null,
          botPausedById: null,
          unreadCount: 0,
          lastMessageAt: null,
          lastMessagePreview: null,
          createdAt: new Date(),
        };
        apply(row, data);
        s.threads.push(row);
        return pick(row, select);
      }),
      update: vi.fn(async ({ where, data, select }: Row) => {
        const row = byKey(where);
        if (!row) throw new Error('no row');
        apply(row, data);
        return pick(row, select);
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = s.threads.filter((t) => threadWhere(t, where));
        rows.forEach((r) => apply(r, data));
        return { count: rows.length };
      }),
    },
    landingChatMessage: {
      findMany: vi.fn(async ({ where, select, take, orderBy }: Row) => {
        let rows = s.lines.filter((m) => lineWhere(m, where));
        if (orderBy?.seq === 'asc') rows = rows.sort((a, b) => (a.seq < b.seq ? -1 : 1));
        if (take) rows = rows.slice(0, take);
        return rows.map((m) => pick(m, select));
      }),
      count: vi.fn(async ({ where }: Row) => s.lines.filter((m) => lineWhere(m, where)).length),
      createMany: vi.fn(async ({ data }: Row) => {
        let count = 0;
        for (const d of data as Row[]) {
          if (d.externalId && s.lines.some((m) => m.threadId === d.threadId && m.externalId === d.externalId)) continue;
          s.lines.push(newLine(d));
          count++;
        }
        return { count };
      }),
      create: vi.fn(async ({ data, select }: Row) => {
        const row = newLine({ ...data, createdAt: new Date(Date.now() - 10_000) });
        s.lines.push(row);
        return pick(row, select);
      }),
    },
    notification: {
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = s.notifications.filter((n) => n.companyId === where.companyId && n.userId === where.userId && n.isRead === where.isRead && n.type === where.type && n.link === where.link);
        rows.forEach((n) => Object.assign(n, data));
        return { count: rows.length };
      }),
    },
  };
  db.$transaction = vi.fn(async (fn: (tx: Row) => unknown) => fn(db));
  return { db, default: db };
});

import { hashToken } from './system-token';
import { POST as relay } from '@/app/api/v1/landing/chat/messages/route';
import { GET as updates } from '@/app/api/v1/landing/chat/updates/route';
import { LANDING_INBOX_PATH } from './landing-chat-inbox';
import { listLandingThreads, markLandingThreadRead, readLandingThread, replyAsStaff, setLandingBotPaused } from '@/lib/inbox/landing-threads';

const KEY_A = 'zk1_company_a_landing_key';
const KEY_B = 'zk1_company_b_landing_key';
const READ_ONLY = 'zk1_products_read_only_key';
const SESSION = '0b8f7a7e-1111-4c2b-9d7e-000000000001';

const staffA = { id: 'u1', name: 'ريم' };

let keyNo = 0;
const send = (body: unknown, opts: { token?: string | null; key?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? KEY_A : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const key = opts.key === undefined ? `k${++keyNo}` : opts.key;
  if (key) headers['idempotency-key'] = key;
  return relay(new Request('https://oms.test/api/v1/landing/chat/messages', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
};
const read = (after?: string, token = KEY_A) =>
  updates(new Request(`https://oms.test/api/v1/landing/chat/updates${after ? `?after=${after}` : ''}`, { headers: { authorization: `Bearer ${token}` } }));

const BASE = {
  sessionId: SESSION,
  mode: 'confirm',
  page: { id: 'lp1', slug: 'rummana', name: 'رمانة', url: 'https://pages.zakiai.io/lp/rummana' },
  productId: 'p1',
  productName: 'دبس رمان',
  orderNumber: 'JO-2026-0007',
};
const welcome = { id: '1', role: 'bot', text: 'أهلين، أنا سارة', at: '2026-11-18T10:00:00.000Z' };
const hello = { id: '2', role: 'customer', text: 'مرحبا بدي اسأل عن التوصيل', at: '2026-11-18T10:00:05.000Z' };
const answer = { id: '3', role: 'bot', text: 'التوصيل خلال يومين', at: '2026-11-18T10:00:07.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  const s = h.state;
  s.idem.clear();
  s.threads.length = 0;
  s.lines.length = 0;
  s.orders.length = 0;
  s.notifications.length = 0;
  s.tokens.clear();
  const token = (id: string, companyId: string, scopes: string[]) => ({
    id,
    companyId,
    system: 'landing',
    scopes: JSON.stringify(scopes),
    rateLimitPerMin: 600,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: new Date(),
  });
  s.tokens.set(hashToken(KEY_A), token('ta', 'cA', ['products.read', 'orders.create']));
  s.tokens.set(hashToken(KEY_B), token('tb', 'cB', ['products.read', 'orders.create']));
  s.tokens.set(hashToken(READ_ONLY), token('tr', 'cA', ['products.read']));
  s.orders.push({ id: 'ord7', companyId: 'cA', orderNumber: 'JO-2026-0007' });
});

describe('the key comes first, and it is the landing key that already exists', () => {
  it('no key → 401; a key without orders.create → 403; nothing is written', async () => {
    expect((await send({ ...BASE, messages: [hello] }, { token: null })).status).toBe(401);
    expect((await send({ ...BASE, messages: [hello] }, { token: READ_ONLY })).status).toBe(403);
    expect((await read(undefined, READ_ONLY)).status).toBe(403);
    expect(h.state.threads).toHaveLength(0);
  });

  it('a write without an Idempotency-Key is refused in the machine envelope', async () => {
    const r = await send({ ...BASE, messages: [hello] }, { key: null });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('a body it cannot take is an Arabic sentence, and the key is not held', async () => {
    const r = await send({ messages: [hello] }, { key: 'bad-1' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/sessionId/);
    expect(h.state.idem.size).toBe(0);
  });
});

describe('POST /chat/messages — every line once, from the first one', () => {
  it('makes the thread on its first relay (201), with the page, the product and the linked order', async () => {
    const r = await send({ ...BASE, messages: [welcome] });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { threadId: string; botPaused: boolean; written: number };
    expect(body).toMatchObject({ botPaused: false, written: 1 });
    const t = h.state.threads[0];
    expect(t).toMatchObject({ companyId: 'cA', externalId: SESSION, pageName: 'رمانة', pageSlug: 'rummana', productName: 'دبس رمان', orderNumber: 'JO-2026-0007', orderId: 'ord7' });
    // A thread with only the assistant's welcome is nobody's news yet.
    expect(t.unreadCount).toBe(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('the same lines again — same key or a new one — write nothing twice', async () => {
    const first = await (await send({ ...BASE, messages: [welcome, hello] }, { key: 'same' })).json();
    const again = await send({ ...BASE, messages: [welcome, hello] }, { key: 'same' });
    expect(await again.json()).toEqual(first); // the first answer, replayed
    const fresh = await send({ ...BASE, messages: [welcome, hello] });
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { written: number }).written).toBe(0);
    expect(h.state.lines).toHaveLength(2);
    expect(h.state.threads[0].unreadCount).toBe(1);
  });

  it('counts the customer’s lines as unread, never the assistant’s, and moves the preview on', async () => {
    await send({ ...BASE, messages: [welcome, hello, answer] });
    const t = h.state.threads[0];
    expect(t.unreadCount).toBe(1);
    expect(t.lastMessagePreview).toBe('التوصيل خلال يومين');
    expect(h.state.lines.map((m) => m.direction)).toEqual(['BOT', 'CUSTOMER', 'BOT']);
  });

  it('tells the people who answer once per unread run, without the text', async () => {
    await send({ ...BASE, messages: [welcome, hello] });
    expect(h.notify).toHaveBeenCalledTimes(1);
    const n = h.notify.mock.calls[0][0];
    expect(n).toMatchObject({ companyId: 'cA', type: 'LANDING_CHAT', link: LANDING_INBOX_PATH, audience: { permission: 'whatsapp.view' } });
    expect(n.title).toBe('محادثة جديدة من صفحة الهبوط');
    expect(JSON.stringify(n)).not.toContain('التوصيل');
    // Still unread: another line is no new notice.
    await send({ ...BASE, messages: [{ id: '4', role: 'customer', text: 'وكمان سؤال' }] });
    expect(h.notify).toHaveBeenCalledTimes(1);
    // Read, then the customer writes again: one notice.
    await markLandingThreadRead('cA', 'u1', h.state.threads[0].id);
    await send({ ...BASE, messages: [{ id: '5', role: 'customer', text: 'مرحبا؟' }] });
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls[1][0].title).toBe('رسالة جديدة من صفحة الهبوط');
  });

  it('a later relay without the phone never empties a known one; a new order number is linked', async () => {
    await send({ ...BASE, orderNumber: null, mode: 'intake', customerPhone: '0791234567', customerName: 'محمد', messages: [welcome] });
    expect(h.state.threads[0]).toMatchObject({ mode: 'intake', customerPhone: '0791234567', orderId: null });
    await send({ ...BASE, mode: 'intake', messages: [hello] });
    expect(h.state.threads[0]).toMatchObject({ customerPhone: '0791234567', customerName: 'محمد', orderNumber: 'JO-2026-0007', orderId: 'ord7' });
  });

  it('another company’s key makes another company’s thread — the session id is not a door between them', async () => {
    await send({ ...BASE, messages: [hello] });
    await send({ ...BASE, messages: [hello] }, { token: KEY_B });
    expect(h.state.threads.map((t) => t.companyId).sort()).toEqual(['cA', 'cB']);
    // Company B has no order JO-2026-0007: nothing is linked.
    expect(h.state.threads.find((t) => t.companyId === 'cB')!.orderId).toBeNull();
  });
});

describe('the staff answer, and the bot steps aside', () => {
  it('the first reply pauses the bot — the pause line, then the reply — and the relay answer says so', async () => {
    await send({ ...BASE, messages: [welcome, hello] });
    const id = h.state.threads[0].id;
    const r = await replyAsStaff('cA', staffA, id, 'أهلين، معك ريم من فريق الدعم');
    expect(r.ok).toBe(true);
    expect(h.state.threads[0]).toMatchObject({ botPaused: true, botPausedById: 'u1', unreadCount: 0 });
    expect(h.state.lines.slice(-2).map((m) => [m.direction, m.event])).toEqual([
      ['EVENT', 'BOT_PAUSED'],
      ['STAFF', null],
    ]);
    const next = await send({ ...BASE, messages: [{ id: '9', role: 'customer', text: 'تمام شكرا' }] });
    expect(((await next.json()) as { botPaused: boolean }).botPaused).toBe(true);
    // A second reply does not pause twice.
    await replyAsStaff('cA', staffA, id, 'العفو');
    expect(h.state.lines.filter((m) => m.event === 'BOT_PAUSED')).toHaveLength(1);
  });

  it('«رجّع للبوت» writes one resume line; the same state twice writes nothing', async () => {
    await send({ ...BASE, messages: [hello] });
    const id = h.state.threads[0].id;
    await replyAsStaff('cA', staffA, id, 'أهلين');
    const back = await setLandingBotPaused('cA', staffA, id, false);
    expect(back).toEqual({ ok: true, botPaused: false, changed: true });
    expect(await setLandingBotPaused('cA', staffA, id, false)).toEqual({ ok: true, botPaused: false, changed: false });
    expect(h.state.lines.filter((m) => m.event === 'BOT_RESUMED')).toHaveLength(1);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'LANDING_CHAT_BOT_RESUMED', entityId: id }));
  });

  it('another company’s thread answers «غير موجودة» to every staff door', async () => {
    await send({ ...BASE, messages: [hello] });
    const id = h.state.threads[0].id;
    expect(await replyAsStaff('cB', staffA, id, 'x')).toMatchObject({ ok: false, status: 404 });
    expect(await setLandingBotPaused('cB', staffA, id, true)).toMatchObject({ ok: false, status: 404 });
    expect(await readLandingThread('cB', id)).toBeNull();
    expect(await markLandingThreadRead('cB', 'u1', id)).toBe(false);
  });

  it('reading the thread clears its unread count and the reader’s notices of the inbox', async () => {
    await send({ ...BASE, messages: [hello] });
    h.state.notifications.push({ companyId: 'cA', userId: 'u1', isRead: false, type: 'LANDING_CHAT', link: LANDING_INBOX_PATH });
    h.state.notifications.push({ companyId: 'cA', userId: 'u2', isRead: false, type: 'LANDING_CHAT', link: LANDING_INBOX_PATH });
    await markLandingThreadRead('cA', 'u1', h.state.threads[0].id);
    expect(h.state.threads[0].unreadCount).toBe(0);
    expect(h.state.notifications.map((n) => n.isRead)).toEqual([true, false]);
  });

  it('the list filters unread and the threads the staff hold', async () => {
    await send({ ...BASE, messages: [hello] });
    await send({ ...BASE, sessionId: '0b8f7a7e-1111-4c2b-9d7e-000000000002', messages: [welcome] });
    expect((await listLandingThreads('cA', { filter: 'unread' })).threads).toHaveLength(1);
    await replyAsStaff('cA', staffA, h.state.threads[1].id, 'أهلين');
    const held = (await listLandingThreads('cA', { filter: 'staff' })).threads;
    expect(held.map((t) => t.id)).toEqual([h.state.threads[1].id]);
  });
});

describe('GET /chat/updates — what the staff did, in order, behind a cursor', () => {
  it('hands out the pause, the replies and the resume of this company only, and moves the cursor', async () => {
    await send({ ...BASE, messages: [welcome, hello] });
    await send({ ...BASE, sessionId: '0b8f7a7e-1111-4c2b-9d7e-00000000000b', messages: [hello] }, { token: KEY_B });
    const idA = h.state.threads[0].id;
    const idB = h.state.threads[1].id;
    await replyAsStaff('cA', staffA, idA, 'أهلين');
    await replyAsStaff('cB', { id: 'u9', name: 'x' }, idB, 'شركة ثانية');
    await setLandingBotPaused('cA', staffA, idA, false);

    const r = await read();
    expect(r.status).toBe(200);
    const body = (await r.json()) as { updates: Array<Record<string, string>>; cursor: string; more: boolean };
    expect(body.updates.map((u) => [u.kind, u.sessionId, u.text ?? null])).toEqual([
      ['paused', SESSION, null],
      ['staff', SESSION, 'أهلين'],
      ['resumed', SESSION, null],
    ]);
    // The customer's and the assistant's own lines never come back; neither does the staff member's name.
    expect(JSON.stringify(body)).not.toContain('ريم');
    expect(body.more).toBe(false);
    const after = (await (await read(body.cursor)).json()) as { updates: unknown[]; cursor: string };
    expect(after.updates).toEqual([]);
    expect(after.cursor).toBe(body.cursor);
  });

  it('a line still settling is not handed out yet, and the cursor does not pass it', async () => {
    await send({ ...BASE, messages: [hello] });
    await replyAsStaff('cA', staffA, h.state.threads[0].id, 'أهلين');
    h.state.lines.at(-1)!.createdAt = new Date(); // this instant
    const body = (await (await read()).json()) as { updates: Array<{ kind: string; seq: string }>; cursor: string };
    expect(body.updates.map((u) => u.kind)).toEqual(['paused']);
    expect(body.cursor).toBe(body.updates[0].seq);
  });

  it('an unreadable cursor is a validation fault', async () => {
    const r = await read('abc');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });
});
