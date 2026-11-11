import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { auditWhere, describeAction, entityLabel } from './audit-view';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the audit row «أرجِع «لا يرد» للطابور» writes is READ IN ARABIC on the audit screen.
 *
 * The door (`POST /api/confirmation/desks/[agentId]/return-no-answer`) writes `DESK_NO_ANSWER_RETURNED` on the agent's record
 * (`User`). The audit screen turns a code into words with `ACTION_AR` (a whole code) or `VERB_AR` (its last word); this code had
 * neither — `RETURNED` is not a verb there — so the owner's screen showed the raw English code, in a product whose every visible
 * word is Arabic (`describeAction` falls back to the code itself rather than hiding a row).
 *
 *  1. Every audit action the door's source writes has an Arabic phrase that is not the code and carries no code-shaped word.
 *  2. The phrase is the owner's: «إرجاع كومة «لا يرد» لموظفة للطابور», and the record it names (`User`) is «مستخدم».
 *  3. The screen's search finds the row by its Arabic words.
 *
 * Read from the door's source, so a second action added to it later is checked without anybody remembering to.
 * Blockers: no money, no permission, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const DOOR = 'src/app/api/confirmation/desks/[agentId]/return-no-answer/route.ts';
const ARABIC = /[؀-ۿ]/;

const src = stripComments(repoFile(DOOR));
const actions = [...src.matchAll(/action:\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
const entities = [...src.matchAll(/entity:\s*'([A-Za-z]+)'/g)].map((m) => m[1]);

describe('every audit action the return door writes has an Arabic label', () => {
  it('the scan found the door’s action and its record kind (a sweep over nothing proves nothing)', () => {
    expect(actions).toEqual(['DESK_NO_ANSWER_RETURNED']);
    expect(entities).toEqual(['User']);
  });

  it.each(actions)('«%s» reads as words — not as itself, and with no code-shaped word in it', (action) => {
    const said = describeAction(action, entities[0]);
    expect(said).not.toBe(action);
    expect(said).toMatch(ARABIC);
    expect(said).not.toMatch(/[A-Z][A-Z0-9_]{3,}/);
  });

  it('the phrase is the owner’s, and the record it is about is a person', () => {
    expect(describeAction('DESK_NO_ANSWER_RETURNED', 'User')).toBe('إرجاع كومة «لا يرد» لموظفة للطابور');
    expect(entityLabel('User')).toBe('مستخدم');
  });

  it('typing the Arabic words on the audit screen finds the row', () => {
    const or = (auditWhere('co-1', { q: 'كومة' }) as unknown as { AND: { OR: unknown[] }[] }).AND[0].OR;
    expect(or).toContainEqual({ action: { in: ['DESK_NO_ANSWER_RETURNED'] } });
  });
});

/**
 * AND «استلام الكل» (11/11): the door writes ONE row for the press (`RETURNS_RECEIVED_ALL`, on the store) and every parcel
 * keeps the single receipt's own row (`RETURN_RECEIVED`, on the order, written by lib/return-receipt.ts with `bulk: true`).
 * Both read in Arabic. Scanned from the two sources, like the door above.
 */
const BULK_SOURCES = ['src/app/api/ops/returns/receive-all/route.ts', 'src/lib/return-receipt.ts'];
const bulkSrc = BULK_SOURCES.map((p) => stripComments(repoFile(p))).join('\n');
const bulkActions = [...bulkSrc.matchAll(/action:\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
const bulkEntities = [...bulkSrc.matchAll(/entity:\s*'([A-Za-z]+)'/g)].map((m) => m[1]);

describe('the receipt rows «استلام الكل» writes read in Arabic', () => {
  it('the scan found both rows and their records (a sweep over nothing proves nothing)', () => {
    expect(bulkActions.sort()).toEqual(['RETURNS_RECEIVED_ALL', 'RETURN_RECEIVED']);
    expect(bulkEntities.sort()).toEqual(['Order', 'Store']);
  });

  it.each(bulkActions)('«%s» reads as words — not as itself, and with no code-shaped word in it', (action) => {
    const said = describeAction(action, 'Order');
    expect(said).not.toBe(action);
    expect(said).toMatch(ARABIC);
    expect(said).not.toMatch(/[A-Z][A-Z0-9_]{3,}/);
  });

  it('the press reads as the owner asked for it, and its record is the store', () => {
    expect(describeAction('RETURNS_RECEIVED_ALL', 'Store')).toBe('استلام كل المرتجعات دفعة واحدة');
    expect(entityLabel('Store')).toBe('متجر');
  });

  it('typing the Arabic words on the audit screen finds the press', () => {
    const or = (auditWhere('co-1', { q: 'دفعة واحدة' }) as unknown as { AND: { OR: unknown[] }[] }).AND[0].OR;
    expect(JSON.stringify(or)).toContain('RETURNS_RECEIVED_ALL');
  });
});
