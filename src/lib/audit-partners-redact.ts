import { stripJson } from './audit-pay-redact';

/**
 * THE PARTNERS' SHARES AND DRAWS IN THE AUDIT TRAIL ARE THE PARTNERS' KEY'S.
 *
 * «سجل التدقيق» opens on `audit.view`, which the stage-2 templates give the
 * accountant and the settlement officer. The partners' two doors each write a
 * row that carries exactly what `finance.partners` (the owner's alone) exists
 * to keep: saving the list wrote every partner's name and share, before and
 * after (`PARTNERS_SAVED`, entity `Partner`); recording a draw wrote the
 * partner, the amount, its value in the store's currency and the note
 * (`PARTNER_DRAW_RECORDED`). The audit route handed both, verbatim, to every
 * reader of the trail.
 *
 * The rows stay — when, by whom, and what kind of act is what the audit is
 * for. The names, the shares and the amounts are taken out for anyone without
 * `finance.partners`, and the row says so (`partnersWithheld`), so the screen
 * can say why a field is missing. Same shape as the pay redaction next door.
 */

type AuditRow = { action: string; entity: string; previousData: string | null; newData: string | null };

/**
 * What may stay on a row, by the action that wrote it. An ALLOW-list, like
 * pay's: a field added to one of these payloads tomorrow is held back until
 * somebody decides it is safe, rather than shown until somebody notices.
 *
 * Keyed by ACTION because the entity of a draw is `WalletMovement`, which
 * every ordinary wallet row shares.
 */
const SAFE_KEYS_OF_ACTION: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Where the money left from — the cash box and its currency. Not who took it, how much, or why.
  ['PARTNER_DRAW_RECORDED', new Set(['wallet', 'currencyCode', 'storeCurrency'])],
]);

/** The rows that are about the partners' list through and through: nothing of their data stays. */
const SAFE_KEYS_OF_ENTITY: ReadonlyMap<string, ReadonlySet<string>> = new Map([['Partner', new Set<string>()]]);

/** A cut that left an empty object is no data at all: the screen shows «—» and the note, not «{}». */
const nothingLeft = (raw: string | null) => (raw === '{}' ? null : raw);

/** One audit row as somebody without `finance.partners` may read it. */
export function withoutPartners<T extends AuditRow>(row: T): T & { partnersWithheld?: true } {
  const safe = SAFE_KEYS_OF_ACTION.get(row.action) ?? SAFE_KEYS_OF_ENTITY.get(row.entity);
  if (!safe) return row;
  const held = (key: string) => !safe.has(key);
  const before = stripJson(row.previousData, held);
  const after = stripJson(row.newData, held);
  const out = { ...row, previousData: nothingLeft(before.raw), newData: nothingLeft(after.raw) };
  if (!before.touched && !after.touched) return out;
  return { ...out, partnersWithheld: true };
}
