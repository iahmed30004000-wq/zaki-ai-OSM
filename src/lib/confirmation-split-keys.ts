/**
 * THE CONFIRMATION AND CHANGE-REQUEST DOORS THAT GOT A BOX EACH (perm-plan PR-7), AND WHO PASSED THEM BEFORE.
 *
 * Seven keys, and one fix:
 *
 *   confirmation.winback          ← confirmation.supervise     (the discounted win-back offer rode on the supervisors' list)
 *   confirmation.reassign         ← confirmation.supervise     (handing somebody else's postponed order back to the pool)
 *   confirmation.issues_correct   ← confirmation.issues        (closing an entry issue rode on seeing the list)
 *   confirmation.raise_issue      ← confirmation.issues        (raising one rode on seeing the list) + D14 below
 *   control.change_requests_view  ← control.change_requests    (seeing the WHOLE desk) + four role NAMES
 *   ops.decide_changes            ← ops.ship                   (deciding at the packing table) + the role NAME WAREHOUSE
 *   orders.change_price           ← the three ways a person decided a request (see below)
 *   customers.view_basic          ← customers.view             (an orphan: the full tier without the page key)
 *
 * `from` is OR: whoever held ANY of them yesterday passed the door, so whoever held any of them holds the new key today.
 *
 * `byRole` is the part of the old door that was a NAME and not a key: `change-requests/route.ts` read four role names,
 * `change-request-routing.ts` read `WAREHOUSE`. The migration gives the key to every person whose `users.role` is one of
 * those names — the day after the deploy the same people pass, and from then on the owner can untick them.
 *
 * `newForRoles` is the ONE deliberate gain (D14): a confirmation agent has a button «إدخال إشكال» on her own desk that
 * always answered 403, because the door asked for the issues LIST she was never given. She gets the box. Nothing else in
 * this file gives anybody a door they did not have.
 *
 * `unless` is for the money rule. Deciding a request that touches money now needs `orders.change_price`. Whoever holds
 * `orders.edit` already received that key from the previous migration (20261030130000), and if the owner unticked it
 * since, that was his choice — so they are not touched here. Everybody else who could decide such a request yesterday
 * (the desk, the packing table, the agent holding the order) gets the key so that nobody loses the decision. It is
 * conferred WITHOUT `orders.edit`, which every direct price edit still asks first — so no edit door opens with it.
 *
 * The migration 20261030140000_confirmation_split_keys writes it into the database from the same list (a test reads the
 * SQL and this table side by side), and the in-code fallback in permissions-core applies it to a person with no stored role.
 */
export interface ConfirmationSplitKey {
  readonly key: string;
  readonly from: readonly string[];
  /** A door that was a role NAME: `users.role` equal to one of these passed yesterday. */
  readonly byRole?: readonly string[];
  /** The deliberate gain (D14). */
  readonly newForRoles?: readonly string[];
  /** Skip whoever holds this key: they were judged by an earlier migration. */
  readonly unless?: string;
  /** The new key keeps the scope of the key it comes from. */
  readonly copyScope: boolean;
  /**
   * `false` = the in-code fallback (a person with NO stored role and no template) does not derive this key. Only the money
   * rule says so: the fallback cannot see the legacy keys that make somebody a decider the way a stored row can, and a
   * person answered by the fallback does not exist in a migrated database (every system role has its template since the
   * permission-engine migration). The migration writes the key to anybody who holds a deciding key by a personal «سماح».
   */
  readonly inFallback?: boolean;
}

/** The four role names the change-request desk read BY NAME (change-requests/route.ts) until this change. */
export const CHANGE_DESK_ROLE_NAMES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'CONFIRMATION_SUPERVISOR'] as const;

/** The role name the packing-table door read BY NAME (change-request-routing.ts) until this change. */
export const WAREHOUSE_ROLE_NAMES = ['WAREHOUSE'] as const;

/** The role that gets «إدخال إشكال» for the first time (D14). */
export const ISSUE_RAISER_ROLE_NAMES = ['CONFIRMATION_AGENT'] as const;

/**
 * The keys a person could DECIDE a change request through, before this change:
 *   · the desk                         control.change_requests
 *   · the packing table                ops.ship (and the name WAREHOUSE)
 *   · the agent holding the order      whoever can hold a claim: pull, work, claim
 */
export const DECIDER_KEYS = ['control.change_requests', 'ops.ship', 'confirmation.pull', 'confirmation.work', 'orders.claim'] as const;

export const CONFIRMATION_SPLIT_KEYS_FROM: readonly ConfirmationSplitKey[] = [
  { key: 'confirmation.winback', from: ['confirmation.supervise'], copyScope: false },
  { key: 'confirmation.reassign', from: ['confirmation.supervise'], copyScope: false },
  { key: 'confirmation.issues_correct', from: ['confirmation.issues'], copyScope: false },
  { key: 'confirmation.raise_issue', from: ['confirmation.issues'], newForRoles: ISSUE_RAISER_ROLE_NAMES, copyScope: false },
  { key: 'control.change_requests_view', from: ['control.change_requests'], byRole: CHANGE_DESK_ROLE_NAMES, copyScope: false },
  { key: 'ops.decide_changes', from: ['ops.ship'], byRole: WAREHOUSE_ROLE_NAMES, copyScope: false },
  { key: 'orders.change_price', from: DECIDER_KEYS, byRole: WAREHOUSE_ROLE_NAMES, unless: 'orders.edit', copyScope: false, inFallback: false },
  { key: 'customers.view_basic', from: ['customers.view'], copyScope: true },
];

/** Every role name that opens a split door by name, for the key it is asked of — the part of the old door that was a name. */
export function rolesThatPassedByName(rule: ConfirmationSplitKey): readonly string[] {
  return [...(rule.byRole ?? []), ...(rule.newForRoles ?? [])];
}
