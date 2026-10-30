import type { SessionUser } from '@/types/auth';
import { getPermissionScope } from '../authorization';

/**
 * WHICH CONVERSATIONS THIS PERSON MAY TOUCH (perm-plan PR-13, WA-3, D1-i).
 *
 * `whatsapp.view` can be saved at «المسندة إليه» (ASSIGNED), and the screens that grant it show the choice — but the inbox
 * doors never read the scope, so a person limited to her own conversations listed, opened, answered and closed every
 * conversation of the company. The stored choice is obeyed now: ASSIGNED sees the conversations assigned to her and the
 * ones nobody has taken yet (the pool she can take from), and nothing else.
 *
 * `null` = no restriction. That is the answer for «كل الشركة», for the owner (who holds everything centrally), and also for
 * a person with NO view scope at all: the doors that do not ask the view key (sending, closing) must not start refusing
 * somebody the engine never narrowed — the doors that DO ask it have already refused a person without it.
 *
 * ONLY «المسندة إليه» narrows. The migration that introduced the inbox (20260911150000) copied `whatsapp.view` from the orders and
 * customers rows WITH their scope, so some roles carry an OWN row the catalog never offered and no screen can tick; reading it
 * as narrowing would take conversations away from people on the day of the deploy. The owner decided D1-i for ASSIGNED, and
 * that is all this obeys.
 *
 * Returned as a Prisma fragment to put inside `AND: [ … ]`, so it never collides with the search's own `OR`.
 */
export function inboxScopeWhere(user: SessionUser): Record<string, unknown> | null {
  const scope = getPermissionScope(user, 'whatsapp.view');
  if (scope?.scope !== 'ASSIGNED') return null;
  return { OR: [{ assignedUserId: user.id }, { assignedUserId: null }] };
}
