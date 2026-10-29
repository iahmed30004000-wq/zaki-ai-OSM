/**
 * THE EXCEPTIONS EDITOR'S PLAN — what a single exception pulls with it.
 *
 * Client-safe (no server imports), so the screen can show the plan before the
 * press and the test can sweep it over every key.
 *
 * The door (`PUT /api/users/:id/permissions`) refuses a list that leaves a
 * person holding an action without the key that opens its screen
 * (`ORPHAN_ACTION`). So the screen must never send such a list. It works out
 * what the person would hold AFTER the change — the role's keys with the
 * exceptions on top, the engine's own order: «منع» removes, «منح» adds — and
 * adds the exceptions that keep the result whole:
 *
 *   · «منح» on an action whose screen key the person would not hold: the
 *     screen key is granted with it (at the same scope when the key offers it,
 *     otherwise for the whole company), and a «منع» on it is lifted.
 *   · «منع» on a screen key: its actions the person would still hold are
 *     denied with it.
 *
 * Nothing here decides who MAY grant — the door does that. `canGrant` only
 * lets the screen say so before the press, instead of after a refusal.
 */
import {
  catalogItem,
  dependentsOf,
  newOrphans,
  requiredChain,
  viewGrantFor,
  type ScopeValue,
} from './permission-catalog';

export interface PlanRow {
  permission: string;
  effect: 'ALLOW' | 'DENY';
  scope?: string;
  scopeIds?: string[];
}

export interface PlanDraft {
  key: string;
  effect: 'ALLOW' | 'DENY';
  scope: ScopeValue;
  scopeIds: string[];
}

export interface Plan {
  /** The whole list to send: the other exceptions, this one, and what it pulls in. */
  list: PlanRow[];
  /** One Arabic line per extra exception the plan adds or lifts. */
  notes: string[];
  /** Why the plan cannot be sent (the person lacks a key it needs to grant), or null. */
  blocked: string | null;
}

const label = (key: string) => `«${catalogItem(key)?.ar ?? key}»`;

/** The keys held once the exceptions are laid over the role's: «منع» removes, «منح» adds. */
export function heldAfter(baseKeys: Iterable<string>, rows: readonly PlanRow[]): Set<string> {
  const held = new Set(baseKeys);
  for (const r of rows) {
    if (r.effect === 'DENY') held.delete(r.permission);
    else held.add(r.permission);
  }
  return held;
}

function allowRow(key: string, scope: ScopeValue, scopeIds: string[]): PlanRow {
  const scoped = scope === 'CATEGORY' || scope === 'SPECIFIC';
  return { permission: key, effect: 'ALLOW', scope, ...(scoped && scopeIds.length > 0 ? { scopeIds } : {}) };
}

export function planOverride(input: {
  /** What the person holds from the role (or its template), before any exception. */
  baseKeys: Iterable<string>;
  /** Every OTHER exception, as stored. */
  others: readonly PlanRow[];
  draft: PlanDraft;
  /** Whether the person making the change holds this key (so can grant it). */
  canGrant: (key: string) => boolean;
}): Plan {
  const { baseKeys, others, draft, canGrant } = input;
  const without = (rows: readonly PlanRow[], key: string) => rows.filter((r) => r.permission !== key);
  const notes: string[] = [];
  let blocked: string | null = null;

  const own: PlanRow =
    draft.effect === 'ALLOW'
      ? allowRow(draft.key, draft.scope, draft.scopeIds)
      : { permission: draft.key, effect: 'DENY' };
  let list: PlanRow[] = [...without(others, draft.key), own];

  if (draft.effect === 'ALLOW') {
    for (const need of requiredChain(draft.key)) {
      if (heldAfter(baseKeys, list).has(need)) continue;
      if (!canGrant(need)) {
        blocked = `${label(draft.key)} بتحتاج ${label(need)}، وإنت ما عندك ${label(need)} لتمنحها.`;
        break;
      }
      const lifted = list.some((r) => r.permission === need && r.effect === 'DENY');
      const g = viewGrantFor(need, { scope: draft.scope, scopeIds: draft.scopeIds });
      list = [...without(list, need), allowRow(need, g.scope, g.scopeIds)];
      notes.push(
        `ومعها رح ينضاف منح ${label(need)} — ما بتشتغل بدونها${lifted ? '، ورح ينشال المنع عنها' : ''}.`,
      );
    }
  } else {
    const held = heldAfter(baseKeys, list);
    for (const dep of dependentsOf(draft.key)) {
      if (!held.has(dep)) continue;
      list = [...without(list, dep), { permission: dep, effect: 'DENY' }];
      notes.push(`ومعها رح ينضاف منع ${label(dep)} — ما بتشتغل بدون ${label(draft.key)}.`);
    }
  }

  return { list, notes, blocked };
}

/**
 * Why one exception cannot simply be removed, or null.
 *
 * Removing the «منح» of a screen key takes it from an action that needs it;
 * removing the «منع» of an action gives it back without its screen key. The
 * door refuses both (`ORPHAN_ACTION`), so the screen says so first and does
 * not guess what to deny or grant in its place.
 */
export function removalBlock(input: {
  baseKeys: Iterable<string>;
  rows: readonly PlanRow[];
  removing: string;
}): string | null {
  const { baseKeys, rows, removing } = input;
  const row = rows.find((r) => r.permission === removing);
  if (!row) return null;
  const base = [...baseKeys];
  const fresh = newOrphans(
    heldAfter(base, rows),
    heldAfter(base, rows.filter((r) => r.permission !== removing)),
  )[0];
  if (!fresh) return null;
  return row.effect === 'ALLOW'
    ? `ما بينشال ${label(fresh.view)} لحاله — ${label(fresh.action)} بتحتاجه. امنع ${label(fresh.action)} أول.`
    : `ما بينشال المنع عن ${label(fresh.action)} لحاله — بتحتاج ${label(fresh.view)}. امنحه ${label(fresh.view)} أول.`;
}
