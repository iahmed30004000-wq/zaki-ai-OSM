import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, timingSafeEqual } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OWNER'S «اوقف» TO THE MEDIA BUYER — through the installed-apps machinery (PR-B, O5).
 *
 * No outbox was built for it: the media buyer is an installed app, and `owner.stop_requested` is queued as the same `AppDelivery` row every event is, sent by the same
 * `deliverOne`, with the same retries and the same log. What this file proves is what is particular to it:
 *
 *   · the six events of the replies contract are still exactly six; the stop event is registerable but is not one of them
 *   · only an app that registered for it by name is told, and only when it is exactly one company
 *   · the body is the contract's, and the signature is one the MEDIA BUYER's own verifier accepts — timestamp in SECONDS, as its verifier reads it
 *   · the same words twice within two minutes are one request
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, decryptSecret } = vi.hoisted(() => ({
  db: {
    appInstall: { findMany: vi.fn() },
    appDelivery: { createMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  },
  decryptSecret: vi.fn(),
}));
vi.mock('../db', () => ({ db }));
vi.mock('../secrets', () => ({ decryptSecret: (...a: unknown[]) => decryptSecret(...a) }));

import {
  APP_EVENTS,
  EXTRA_APP_EVENTS,
  OWNER_STOP_EVENT,
  companyListeningToStop,
  deliverOne,
  deliveryTimestamp,
  emitOwnerStop,
  isAppEvent,
  isRegisterableEvent,
  signPayload,
} from './events';
import { validate } from './contract';

/** The media buyer's side, copied from its `src/core/step-exec.ts` (`signBody`, `verifySignature`): what it will do with what arrives. */
const signBody = (secret: string, timestamp: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
function verifySignature(secret: string, timestamp: string, body: string, signature: string, nowMs: number, skewS = 300): boolean {
  const t = Number(timestamp);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > skewS) return false;
  const want = Buffer.from(signBody(secret, timestamp, body));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const DIR = join(process.cwd(), 'contracts', 'oms-mediabuyer.v1');
const file = (n: string) => JSON.parse(readFileSync(join(DIR, n), 'utf8'));

const install = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  companyId: 'c1',
  app: { events: JSON.stringify([OWNER_STOP_EVENT]), webhookUrl: 'https://mediabuyer.zakiai.io/api/inbound/oms' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  decryptSecret.mockReturnValue('s3cret');
  db.appDelivery.update.mockResolvedValue({});
  db.appDelivery.findMany.mockResolvedValue([]);
});

describe('the six stay six', () => {
  it('APP_EVENTS is the replies contract’s list, untouched; the stop event is registerable but is not one of them', () => {
    expect([...APP_EVENTS]).toEqual(['order.created', 'order.confirmed', 'order.shipped', 'order.delivered', 'order.returned', 'order.cancelled']);
    expect(isAppEvent(OWNER_STOP_EVENT)).toBe(false);
    expect(isRegisterableEvent(OWNER_STOP_EVENT)).toBe(true);
    expect(isRegisterableEvent('order.created')).toBe(true);
    expect(isRegisterableEvent('order.exploded')).toBe(false);
    expect([...EXTRA_APP_EVENTS]).toEqual([OWNER_STOP_EVENT]);
  });
});

describe('who is told', () => {
  it('only an enabled, active app that registered for the stop request by name', async () => {
    db.appInstall.findMany.mockResolvedValue([
      install(),
      install({ id: 'i2', app: { events: '["order.created","order.delivered"]', webhookUrl: 'https://replies.test/h' } }),
      install({ id: 'i3', app: { events: 'not json', webhookUrl: 'https://broken.test/h' } }),
    ]);
    expect(await emitOwnerStop('c1', { query: 'CR00147', source_chat: 'owner' })).toBe(1);
    const rows = db.appDelivery.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: 'c1', installId: 'i1', event: OWNER_STOP_EVENT, url: 'https://mediabuyer.zakiai.io/api/inbound/oms', status: 'PENDING' });
    expect(db.appInstall.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', enabled: true, app: { status: 'ACTIVE' } });
  });

  it('the replies system, registered for the six, is never told', async () => {
    db.appInstall.findMany.mockResolvedValue([install({ app: { events: JSON.stringify(APP_EVENTS), webhookUrl: 'https://replies.test/h' } })]);
    expect(await emitOwnerStop('c1', { query: 'CR00147', source_chat: 'owner' })).toBe(0);
    expect(db.appDelivery.createMany).not.toHaveBeenCalled();
  });

  it('the body is the contract’s: {event, at, data:{query, source_chat}}, and nothing else', async () => {
    db.appInstall.findMany.mockResolvedValue([install()]);
    await emitOwnerStop('c1', { query: 'CR00147', source_chat: 'owner' });
    const body = JSON.parse(db.appDelivery.createMany.mock.calls[0][0].data[0].payload);
    const schema = file('stop-event.schema.json');
    expect([...validate(schema, body), ...validate(schema.properties.data, body.data)]).toEqual([]);
    expect(Object.keys(body)).toEqual(['event', 'at', 'data']);
    expect(body.data).toEqual({ query: 'CR00147', source_chat: 'owner' });
    expect(validate(schema, file('stop-event.example.json'))).toEqual([]);
  });

  it('the checker is not vacuous: a field too many, a wrong event, a query too long all fail', () => {
    const schema = file('stop-event.schema.json');
    const ok = file('stop-event.example.json');
    expect(validate(schema, { ...ok, extra: 1 }).length).toBeGreaterThan(0);
    expect(validate(schema, { ...ok, event: 'order.created' }).length).toBeGreaterThan(0);
    expect(validate(schema, { ...ok, at: 'yesterday' }).length).toBeGreaterThan(0);
    expect(validate(schema.properties.data, { query: 'x'.repeat(201) }).length).toBeGreaterThan(0);
    expect(validate(schema.properties.data, { query: 'a', extra: 1 }).length).toBeGreaterThan(0);
  });

  it('the same words within two minutes are ONE request — Telegram re-sends an update it did not hear an answer to', async () => {
    db.appInstall.findMany.mockResolvedValue([install()]);
    db.appDelivery.findMany.mockResolvedValue([
      { installId: 'i1', payload: JSON.stringify({ event: OWNER_STOP_EVENT, at: '2026-11-18T10:05:00.000Z', data: { query: 'CR00147', source_chat: 'owner' } }) },
    ]);
    expect(await emitOwnerStop('c1', { query: 'CR00147', source_chat: 'owner' })).toBe(1);
    expect(db.appDelivery.createMany).not.toHaveBeenCalled();
    // other words are another request
    expect(await emitOwnerStop('c1', { query: 'CR00148', source_chat: 'owner' })).toBe(1);
    expect(db.appDelivery.createMany).toHaveBeenCalledTimes(1);
    const window = db.appDelivery.findMany.mock.calls[0][0].where.createdAt.gte as Date;
    expect(Math.round((Date.now() - window.getTime()) / 60_000)).toBe(2);
  });

  it('never throws: announcing must not be able to fail what it announces', async () => {
    db.appInstall.findMany.mockRejectedValue(new Error('db down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(emitOwnerStop('c1', { query: 'CR00147', source_chat: 'owner' })).resolves.toBe(0);
    log.mockRestore();
  });
});

describe('which company', () => {
  it('exactly one company with an enabled app that registered for it is THE company', async () => {
    db.appInstall.findMany.mockResolvedValue([install(), install({ id: 'i2', companyId: 'c1' }), install({ id: 'i9', companyId: 'c9', app: { events: '["order.created"]' } })]);
    expect(await companyListeningToStop()).toBe('c1');
  });

  it('none, or more than one, is nobody: a chat id does not name a company, and a guess about whose ads to pause is refused', async () => {
    db.appInstall.findMany.mockResolvedValue([]);
    expect(await companyListeningToStop()).toBeNull();
    db.appInstall.findMany.mockResolvedValue([install(), install({ id: 'i2', companyId: 'c2' })]);
    expect(await companyListeningToStop()).toBeNull();
  });
});

describe('the delivery the media buyer receives', () => {
  const delivery = (event: string, payload: string) => ({
    id: 'd1', url: 'https://mediabuyer.zakiai.io/api/inbound/oms', payload, event, attempts: 0,
    install: { app: { secret: 'enc', code: 'MEDIABUYER' } },
  });
  const BODY = JSON.stringify({ event: OWNER_STOP_EVENT, at: '2026-11-18T10:05:00+03:00', data: { query: 'CR00147', source_chat: 'owner' } });

  it('the timestamp is in SECONDS for the stop event and in milliseconds for the six (their published contract)', () => {
    expect(deliveryTimestamp(OWNER_STOP_EVENT, 1_763_400_000_123)).toBe('1763400000');
    expect(deliveryTimestamp('order.created', 1_763_400_000_123)).toBe('1763400000123');
  });

  it('is signed so that the media buyer’s OWN verifier accepts it — headers, seconds, body unchanged', async () => {
    db.appDelivery.findUnique.mockResolvedValue(delivery(OWNER_STOP_EVENT, BODY));
    fetchMock.mockResolvedValue({ status: 200 });
    expect(await deliverOne('d1')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mediabuyer.zakiai.io/api/inbound/oms');
    expect(init.body).toBe(BODY);
    const h = init.headers as Record<string, string>;
    expect(h['X-Zaki-Event']).toBe(OWNER_STOP_EVENT);
    expect(h['X-Zaki-Delivery']).toBe('d1');
    expect(h['X-Zaki-Timestamp']).toMatch(/^\d{10}$/);
    expect(h['X-Zaki-Signature']).toBe(signBody('s3cret', h['X-Zaki-Timestamp'], BODY));
    expect(h['X-Zaki-Signature']).toBe(signPayload('s3cret', h['X-Zaki-Timestamp'], BODY));
    expect(verifySignature('s3cret', h['X-Zaki-Timestamp'], BODY, h['X-Zaki-Signature'], Date.now())).toBe(true);
  });

  it('and a millisecond timestamp would have been refused by that verifier — the reason the unit differs', () => {
    const ms = String(Date.now());
    expect(verifySignature('s3cret', ms, BODY, signBody('s3cret', ms, BODY), Date.now())).toBe(false);
  });

  it('a wrong secret, an altered body and an old timestamp are all refused by it', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signBody('s3cret', ts, BODY);
    expect(verifySignature('other', ts, BODY, sig, Date.now())).toBe(false);
    expect(verifySignature('s3cret', ts, BODY.replace('CR00147', 'CR00148'), sig, Date.now())).toBe(false);
    expect(verifySignature('s3cret', ts, BODY, sig, Date.now() + 10 * 60_000)).toBe(false);
  });

  it('the six order events are still sent with the millisecond timestamp, exactly as before', async () => {
    const body = JSON.stringify({ event: 'order.created', at: '2026-11-18T10:05:00.000Z', data: { orderId: 'o1' } });
    db.appDelivery.findUnique.mockResolvedValue(delivery('order.created', body));
    fetchMock.mockResolvedValue({ status: 200 });
    await deliverOne('d1');
    const h = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(h['X-Zaki-Timestamp']).toMatch(/^\d{13}$/);
  });

  it('a failure is retried by the same schedule as any delivery: a 500 stays PENDING with its next attempt, and the log keeps the status', async () => {
    db.appDelivery.findUnique.mockResolvedValue(delivery(OWNER_STOP_EVENT, BODY));
    fetchMock.mockResolvedValue({ status: 500 });
    expect(await deliverOne('d1')).toBe(false);
    expect(db.appDelivery.update.mock.calls[0][0].data).toMatchObject({ status: 'PENDING', attempts: 1, responseCode: 500, error: 'HTTP 500' });
  });
});
