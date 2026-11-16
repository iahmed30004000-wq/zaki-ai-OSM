import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WINBACK_V2_OFF,
  WINBACK_V2_SETTINGS_KEY,
  winbackV2Switch,
  forgetWinbackV2Switch,
  parseWinbackV2Switch,
} from './winback-v2-switch';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE «الاسترجاع اليومي» SWITCH (step F of Confirmation Center v2)
 *
 *  1. OFF unless it is plainly ON: a missing key, a broken document, `enabled` that is not a real `true`, or an `enabledAt` that is not a valid date are all OFF.
 *  2. A read that FAILS (no row, a thrown error, a settings string that is not JSON) is OFF — a filter that touches what an agent is shown never turns itself on by an error.
 *  3. The answer is cached per company for a few seconds, and `forgetWinbackV2Switch` makes the next read see what is stored.
 *  4. It lives in `Company.settings.winbackV2`: no column, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const settingsOf = (value: unknown) => JSON.stringify({ [WINBACK_V2_SETTINGS_KEY]: value });
const clientOf = (settings: string | null | (() => never)) =>
  ({
    company: {
      findUnique: vi.fn(async () => {
        if (typeof settings === 'function') settings();
        return { settings };
      }),
    },
  }) as any;

beforeEach(() => forgetWinbackV2Switch());

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
    expect(parseWinbackV2Switch(raw)).toEqual(WINBACK_V2_OFF);
  });

  it('a real true with a real date is ON, with the moment it went on', () => {
    expect(parseWinbackV2Switch({ enabled: true, enabledAt: '2026-11-15T07:00:00.000Z' })).toEqual({ enabled: true, enabledAt: new Date('2026-11-15T07:00:00.000Z') });
  });
});

describe('the read', () => {
  it('is ON from a stored switch, and the key it reads is winbackV2', async () => {
    const client = clientOf(settingsOf({ enabled: true, enabledAt: '2026-11-15T07:00:00.000Z' }));
    expect((await winbackV2Switch(client, 'c1')).enabled).toBe(true);
    expect(client.company.findUnique).toHaveBeenCalledWith({ where: { id: 'c1' }, select: { settings: true } });
    expect(WINBACK_V2_SETTINGS_KEY).toBe('winbackV2');
  });

  it.each([
    ['no settings at all', null],
    ['settings that are not JSON', '{oops'],
    ['settings without the key', JSON.stringify({ something: 1 })],
  ])('%s → OFF', async (_n, settings) => {
    expect((await winbackV2Switch(clientOf(settings), 'c1')).enabled).toBe(false);
  });

  it('a read that throws is OFF, never an error to the door', async () => {
    const client = clientOf(() => {
      throw new Error('db down');
    });
    expect((await winbackV2Switch(client, 'c1')).enabled).toBe(false);
  });

  it('is cached per company for a few seconds, then read again; forgetting makes the next read fresh', async () => {
    const client = clientOf(settingsOf({ enabled: true, enabledAt: '2026-11-15T07:00:00.000Z' }));
    await winbackV2Switch(client, 'c1', 1_000);
    await winbackV2Switch(client, 'c1', 5_000);
    expect(client.company.findUnique).toHaveBeenCalledTimes(1);
    await winbackV2Switch(client, 'c1', 12_000);
    expect(client.company.findUnique).toHaveBeenCalledTimes(2);
    await winbackV2Switch(client, 'c2', 12_000);
    expect(client.company.findUnique).toHaveBeenCalledTimes(3);
    forgetWinbackV2Switch('c1');
    await winbackV2Switch(client, 'c1', 12_500);
    expect(client.company.findUnique).toHaveBeenCalledTimes(4);
  });
});
