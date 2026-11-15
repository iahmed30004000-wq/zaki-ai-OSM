import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_PROOF_OFF,
  CALL_PROOF_SETTINGS_KEY,
  callProofOn,
  callProofSwitch,
  forgetCallProofSwitch,
  parseCallProofSwitch,
} from './call-proof-switch';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE «إثبات المكالمات وجدول المحاولات» SWITCH (step A of Confirmation Center v2)
 *
 *  1. OFF unless it is plainly ON: a missing key, a broken document, `enabled` that is not a real `true`, or an `enabledAt` that is not a valid date are all OFF.
 *  2. A read that FAILS (no row, a thrown error, a settings string that is not JSON) is OFF — an experiment on work an agent is paid on never turns itself on by an error.
 *  3. The answer is cached per company for a few seconds, and `forgetCallProofSwitch` makes the next read see what is stored.
 *  4. It lives in `Company.settings.callProofAndCadence`: no column, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

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

describe('parse: anything but a plain «on, since a valid date» is off', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'true'],
    ['enabled is the string "true"', { enabled: 'true', enabledAt: '2026-11-15T07:00:00.000Z' }],
    ['enabled without a date', { enabled: true }],
    ['enabled with a null date', { enabled: true, enabledAt: null }],
    ['enabled with a garbage date', { enabled: true, enabledAt: 'not-a-date' }],
    ['disabled with a date', { enabled: false, enabledAt: '2026-11-15T07:00:00.000Z' }],
  ])('%s → OFF', (_name, raw) => {
    expect(parseCallProofSwitch(raw)).toEqual(CALL_PROOF_OFF);
  });

  it('a real true with a real date is ON, with the moment it went on', () => {
    expect(parseCallProofSwitch({ enabled: true, enabledAt: '2026-11-15T07:00:00.000Z' })).toEqual({ enabled: true, enabledAt: new Date('2026-11-15T07:00:00.000Z') });
  });
});

describe('the read', () => {
  it('is ON from a stored switch, and the key it reads is callProofAndCadence', async () => {
    const client = clientOf(settingsOf({ enabled: true, enabledAt: '2026-11-15T07:00:00.000Z' }));
    expect(await callProofOn(client, 'c1')).toBe(true);
    expect(client.company.findUnique).toHaveBeenCalledWith({ where: { id: 'c1' }, select: { settings: true } });
    expect(CALL_PROOF_SETTINGS_KEY).toBe('callProofAndCadence');
  });

  it.each([
    ['no settings at all', null],
    ['settings that are not JSON', '{oops'],
    ['settings without the key', JSON.stringify({ something: 1 })],
  ])('%s → OFF', async (_n, settings) => {
    expect(await callProofOn(clientOf(settings), 'c1')).toBe(false);
  });

  it('a read that throws is OFF, never an error to the door', async () => {
    const client = clientOf(() => {
      throw new Error('db down');
    });
    expect(await callProofOn(client, 'c1')).toBe(false);
  });

  it('is cached per company for a few seconds, then read again; forgetting makes the next read fresh', async () => {
    const client = clientOf(settingsOf({ enabled: true, enabledAt: '2026-11-15T07:00:00.000Z' }));
    await callProofSwitch(client, 'c1', 1_000);
    await callProofSwitch(client, 'c1', 5_000);
    expect(client.company.findUnique).toHaveBeenCalledTimes(1);
    await callProofSwitch(client, 'c1', 12_000);
    expect(client.company.findUnique).toHaveBeenCalledTimes(2);
    await callProofSwitch(client, 'c2', 12_000);
    expect(client.company.findUnique).toHaveBeenCalledTimes(3);
    forgetCallProofSwitch('c1');
    await callProofSwitch(client, 'c1', 12_500);
    expect(client.company.findUnique).toHaveBeenCalledTimes(4);
  });
});
