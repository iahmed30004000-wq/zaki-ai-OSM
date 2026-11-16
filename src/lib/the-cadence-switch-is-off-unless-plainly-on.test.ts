import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_PROOF_SETTINGS_KEY, callProofOn, forgetCallProofSwitch } from './call-proof-switch';
import { cadenceSince } from './no-answer-cadence-switch';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE CADENCE'S READER OF THE ONE SWITCH (step B of Confirmation Center v2)
 *
 *  1. `cadenceSince` answers the moment the switch went on (`enabledAt`) — the FLOOR of every count — or `null`.
 *  2. OFF unless it is plainly ON: a missing key, a broken document, an `enabled` that is not a real `true`, an `enabledAt` that is not a valid date, a read that throws and a
 *     client with no `company` at all are all `null`. Nothing is ever thrown at a door.
 *  3. It keeps no cache of its own: it shares `callProofSwitch`'s, so the proof and the cadence asked in one request are ONE read.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ON_AT = '2026-11-15T07:00:00.000Z';
const settingsOf = (value: unknown) => JSON.stringify({ [CALL_PROOF_SETTINGS_KEY]: value });
const clientOf = (settings: string | null | (() => never)) =>
  ({
    company: {
      findUnique: vi.fn(async () => {
        if (typeof settings === 'function') settings();
        return { settings };
      }),
    },
  }) as any;

beforeEach(() => forgetCallProofSwitch());

describe('cadenceSince', () => {
  it('is the moment the switch went on, for a plain ON', async () => {
    expect(await cadenceSince(clientOf(settingsOf({ enabled: true, enabledAt: ON_AT })), 'c1')).toEqual(new Date(ON_AT));
  });

  it.each([
    ['no settings at all', null],
    ['settings that are not JSON', '{oops'],
    ['settings without the key', JSON.stringify({ something: 1 })],
    ['switched off', settingsOf({ enabled: false, enabledAt: null })],
    ['off with a date', settingsOf({ enabled: false, enabledAt: ON_AT })],
    ['enabled without a date', settingsOf({ enabled: true })],
    ['enabled with a garbage date', settingsOf({ enabled: true, enabledAt: 'not-a-date' })],
    ['enabled as the string "true"', settingsOf({ enabled: 'true', enabledAt: ON_AT })],
  ])('%s → null', async (_n, settings) => {
    expect(await cadenceSince(clientOf(settings), 'c1')).toBeNull();
  });

  it('a read that throws is null, never an error to the door', async () => {
    const boom = clientOf(() => {
      throw new Error('P2024 connection pool timeout');
    });
    await expect(cadenceSince(boom, 'c1')).resolves.toBeNull();
  });

  it('a client with no company at all is null (a test database, a partial mock)', async () => {
    await expect(cadenceSince({} as any, 'c1')).resolves.toBeNull();
  });

  it('shares the proof switch’s cache: asking both inside ten seconds is ONE read', async () => {
    const client = clientOf(settingsOf({ enabled: true, enabledAt: ON_AT }));
    expect(await callProofOn(client, 'c1')).toBe(true);
    expect(await cadenceSince(client, 'c1')).toEqual(new Date(ON_AT));
    expect(client.company.findUnique).toHaveBeenCalledTimes(1);
  });

  it('is per company', async () => {
    const on = clientOf(settingsOf({ enabled: true, enabledAt: ON_AT }));
    const off = clientOf(null);
    expect(await cadenceSince(on, 'c1')).not.toBeNull();
    expect(await cadenceSince(off, 'c2')).toBeNull();
  });
});
