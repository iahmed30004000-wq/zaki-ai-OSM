import { can, hasFullAccess } from './authorization';
import { deskReadiness } from './desk-readiness';
import { resolveAudience } from './notification-audience';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHO CAN PULL IN ONE STORE NOW — the roster the routing rules are judged against (request Q5b of the rules plan, 21/11).
 *
 * A ROUTING rule gives orders to named people; when none of them can pull, its orders must not wait for nobody (`routing-rules.ts`). «Can pull» is read the way a
 * session reads it, never from a key list: the ACTIVE people of the company who reach the store (`resolveAudience` — role rows by roleId or the legacy role's template,
 * personal ALLOW / DENY, `computeEffectiveGrants` → `attachGrants`), then the pull tool of `deskReadiness` asked through the real `can`.
 *
 * Cached thirty seconds per store (the pull is hot: on a warm cache, no statement). A person deactivated, moved or stripped of a key counts again at the next read —
 * within thirty seconds. A read that fails answers null («nobody can pull»: the rule's orders wait their fallback, then go to everyone) — never a stale «somebody».
 *
 * Loaded by the pull only when a rule in force leaves the puller out (a dynamic import), and by the supervisor's board. Reading only.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CACHE_MS = 30_000;
const cache = new Map<string, { staff: ReadonlySet<string> | null; at: number }>();

/** Pure: the ids of the people among `people` (each carrying its grants) whose pull tool is ready. */
function staffOf(people: readonly SessionUser[]): Set<string> {
  const out = new Set<string>();
  for (const p of people) {
    const ready = deskReadiness((k) => can(p, k), { fullAccess: hasFullAccess(p) });
    if (ready.tools.find((t) => t.id === 'pull')?.has) out.add(p.id);
  }
  return out;
}

export async function readRoutingStaff(companyId: string, storeId: string, nowMs: number = Date.now()): Promise<ReadonlySet<string> | null> {
  const key = `${companyId}|${storeId}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_MS) return hit.staff;
  let staff: ReadonlySet<string> | null;
  try {
    staff = staffOf(await resolveAudience({ companyId, storeId, audience: { permission: 'confirmation.pull' } }));
  } catch {
    staff = null;
  }
  cache.set(key, { staff, at: nowMs });
  return staff;
}

