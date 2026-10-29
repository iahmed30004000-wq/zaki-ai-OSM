import { beforeEach, describe, expect, it } from 'vitest';
import {
  SUSPICION_WINDOW_MS,
  forgetBadPasswords,
  noteBadPassword,
  recentBadPassword,
  rememberedBadPasswords,
} from './trusted-device';

/**
 * THE «WRONG PASSWORD» MEMORY HAD NO WAY TO FORGET.
 *
 * An entry was dropped only when the SAME address was asked about again
 * after its quarter of an hour. A stranger trying many different addresses
 * left an entry for each, for the life of the process. Sweeping the stale
 * ones must change no answer: a stale entry is already treated as absent,
 * and one still inside the window must survive any sweep.
 */

const T0 = Date.UTC(2026, 9, 30, 9, 0, 0);
beforeEach(() => forgetBadPasswords());

describe('the memory is swept of what has already expired', () => {
  it('a flood of different addresses does not stay for ever', () => {
    for (let i = 0; i < 1500; i++) noteBadPassword(`stranger${i}@example.com`, T0);
    expect(rememberedBadPasswords()).toBe(1500);

    // A quarter of an hour later the next miss sweeps them.
    noteBadPassword('later@example.com', T0 + SUSPICION_WINDOW_MS);
    expect(rememberedBadPasswords(), 'ما انكنست الإدخالات المنتهية').toBe(1);
  });

  it('NEGATIVE: an entry still inside its window survives the sweep, and still counts as suspicious', () => {
    noteBadPassword('owner@example.com', T0);
    for (let i = 0; i < 1500; i++) noteBadPassword(`stranger${i}@example.com`, T0 + SUSPICION_WINDOW_MS - 1000);
    // The owner's entry is one second from expiry: the sweep ran on the way and kept it.
    expect(recentBadPassword('owner@example.com', T0 + SUSPICION_WINDOW_MS - 1)).toBe(true);
    // …and the strangers inside the window were not dropped either.
    expect(rememberedBadPasswords()).toBeGreaterThanOrEqual(1500);
  });

  it('NEGATIVE: below the threshold nothing is swept at all — small deployments behave exactly as before', () => {
    noteBadPassword('a@example.com', T0);
    noteBadPassword('b@example.com', T0 + SUSPICION_WINDOW_MS + 5);
    expect(rememberedBadPasswords()).toBe(2);
    // The stale one is still answered «no» by the reader, as it always was.
    expect(recentBadPassword('a@example.com', T0 + SUSPICION_WINDOW_MS + 5)).toBe(false);
  });
});
