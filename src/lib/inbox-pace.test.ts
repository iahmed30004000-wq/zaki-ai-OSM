import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import { FAST_POLL_MS, IDLE_POLL_MS, QUIET_POLLS_BEFORE_SLOWING, listSignature, paceFor } from './inbox-pace';

/**
 * AN OPEN INBOX ASKS FEWER TIMES WHEN NOTHING IS HAPPENING, AND NOT ONE SECOND LATER WHEN SOMETHING IS (RV182).
 * The five seconds are the screen's promise; the quiet minute is the only thing that earns the slower pace.
 */

describe('the pace', () => {
  it('— five seconds to begin with, and for eleven quiet polls', () => {
    expect(FAST_POLL_MS).toBe(5_000);
    for (let q = 0; q < QUIET_POLLS_BEFORE_SLOWING; q++) expect(paceFor(q)).toBe(FAST_POLL_MS);
  });

  it('— fifteen seconds only after a whole quiet minute, and for as long as it stays quiet', () => {
    expect(QUIET_POLLS_BEFORE_SLOWING * FAST_POLL_MS).toBe(60_000);
    expect(paceFor(QUIET_POLLS_BEFORE_SLOWING)).toBe(IDLE_POLL_MS);
    expect(paceFor(500)).toBe(IDLE_POLL_MS);
    expect(IDLE_POLL_MS).toBe(15_000);
  });

  it('— a change resets the count, so the next ask is five seconds away again', () => {
    expect(paceFor(0)).toBe(FAST_POLL_MS);
  });
});

describe('what «the list changed» means', () => {
  const a = { id: 'c1', unreadCount: 0, lastMessageAt: '2026-10-30T10:00:00Z' };
  const b = { id: 'c2', unreadCount: 3, lastMessageAt: '2026-10-30T10:05:00Z' };

  it('— the same list is the same signature', () => {
    expect(listSignature([a, b])).toBe(listSignature([{ ...a }, { ...b }]));
  });

  it('— a new unread message, a new last message, a new conversation, a closed one, and a new order of them all move it', () => {
    const base = listSignature([a, b]);
    expect(listSignature([a, { ...b, unreadCount: 4 }])).not.toBe(base);
    expect(listSignature([a, { ...b, lastMessageAt: '2026-10-30T10:06:00Z' }])).not.toBe(base);
    expect(listSignature([a, b, { id: 'c3' }])).not.toBe(base);
    expect(listSignature([a])).not.toBe(base);
    expect(listSignature([b, a])).not.toBe(base);
  });

  it('— a missing count or date reads as none, not as a crash', () => {
    expect(listSignature([{ id: 'c9' }])).toBe(listSignature([{ id: 'c9', unreadCount: 0, lastMessageAt: null }]));
    expect(listSignature([])).toBe('');
  });
});

describe('the screen uses it', () => {
  const screen = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/WhatsAppInboxScreen.tsx'), 'utf8'));

  it('— the timer is the pace, not a number written beside it', () => {
    expect(screen()).toContain('everyMs: pace');
    expect(screen()).not.toMatch(/everyMs:\s*5_?000/);
  });

  it('— a quiet poll counts only when the list did not move; a person’s own request never does', () => {
    expect(screen()).toContain('silent && sig === listSigRef.current ? quietRef.current + 1 : 0');
  });

  it('— the person selecting, sending, coming back to the tab, or a message arriving puts it back to the fast pace', () => {
    const src = screen();
    expect(src).toMatch(/const selectConversation = \(c: Conversation\) => \{\s*speedUp\(\)/);
    expect(src).toMatch(/if \(!selectedId \|\| !composing\.trim\(\) \|\| sending\) return;\s*speedUp\(\)/);
    expect(src).toMatch(/window\.addEventListener\('focus', back\)/);
    expect(src).toMatch(/document\.addEventListener\('visibilitychange', back\)/);
    expect(src).toMatch(/\(d\.messages \|\| \[\]\)\.length > 0\) speedUp\(\)/);
  });

  it('— and the harvest alarm is still behind the list door: this change did not touch it', () => {
    const door = stripComments(readFileSync(join(process.cwd(), 'src/app/api/whatsapp/conversations/route.ts'), 'utf8'));
    expect(door).toContain('noteCustomersHandedOut');
    expect(door).toMatch(/await noteCustomersHandedOut\(\{ companyId, storeId: null, user, where: 'محادثات واتساب', rows: conversations \}\)/);
  });
});
