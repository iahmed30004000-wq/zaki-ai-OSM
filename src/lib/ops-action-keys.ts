/**
 * THE OPERATIONS DOORS THAT GOT A BOX EACH (perm-plan PR-8), AND THE KEY(S) EACH DOOR ASKED BEFORE.
 *
 * Five new keys:
 *
 *   ops.batches    ← ops.ship | ops.track      (seeing the shipping batches: the page and its two read doors)
 *   ops.deliver    ← ops.track                 (recording what happened at the customer's door: delivered, partly, refused)
 *   ops.transfer   ← ops.track                 (moving a parcel to another courier or company)
 *   ops.write_off  ← finance.update | orders.unlock   (closing a lost parcel as a loss; the door was an OR-chain of the two)
 *   ops.return_fee ← ops.returns               (charging the courier a return fee while receiving a return)
 *
 * `from` is OR: whoever held ANY of them yesterday passed the door, so whoever held any of them holds the new key today.
 * No door here evaluated a scope, so every box is conferred at ALL_COMPANY.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *   · `orders.change_status` is not a source of `ops.deliver`. The plan wanted the union, because the order's own shipping
 *     card and the delivery-attempts door also record outcomes — but those two doors do not move in this change, and a
 *     source for a door that did not move would hand `ops.track`'s door to everybody who can change a shipping status.
 *     Whoever moves them adds the source then.
 *   · The change-request branch of the stand-down door (an approved request, carried out) is untouched: it still asks
 *     `control.change_requests` OR `ops.ship`. Moving it onto `ops.decide_changes` would give the carry-out to the role
 *     NAMED WAREHOUSE, which the migration of PR-7 made a decider without `ops.ship`: a door gained.
 *
 * THE STAND-DOWN DOOR (api/ops/shipments/stand-down) IS LEFT ON `ops.ship`, ON PURPOSE. The plan moves it onto `orders.cancel`,
 * but `orders.cancel` already exists, so the move cannot keep the rule: the holders of `ops.ship` would have to receive the
 * cancel box (and with it three other cancel doors), whoever already can cancel would gain the stand-down, and a holder of
 * `ops.ship` carrying a personal «منع» on `orders.cancel` would lose it. Decided under the owner's rule («اي قرار بعد الان
 * اتخذو دون الرجوع الي») in favour of "nobody gains, nobody loses": it waits for a key of its own (a follow-up).
 *
 * The migration 20261030160000_ops_action_keys writes it into the database from the same list (a test reads the SQL and
 * this table side by side), and the in-code fallback in permissions-core applies it to a person with no stored role.
 */
export interface OpsActionKey {
  readonly key: string;
  readonly from: readonly string[];
}

export const OPS_ACTION_KEYS_FROM: readonly OpsActionKey[] = [
  { key: 'ops.batches', from: ['ops.ship', 'ops.track'] },
  { key: 'ops.deliver', from: ['ops.track'] },
  { key: 'ops.transfer', from: ['ops.track'] },
  { key: 'ops.write_off', from: ['finance.update', 'orders.unlock'] },
  { key: 'ops.return_fee', from: ['ops.returns'] },
];
