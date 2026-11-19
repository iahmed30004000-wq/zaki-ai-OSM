import { randomUUID } from 'node:crypto';
import { db } from './db';

/**
 * «سجل الرفض» — WHEN THE DESK SAYS NO, ONE ROW SAYS SO.
 *
 * The confirmation desk refuses on purpose: «اسحبي الطلب أول», «اتصلي أول», «إيدك مليانة», «عم تسحبي بسرعة»… Until now a refusal
 * left nothing behind (only the call-proof refusal had its audit row), so nobody could tell whether a rule ever caught anybody. Each
 * refusing door now calls `logDeskRefusal` once, AFTER it has decided to refuse, and the row is the evidence the rules page counts.
 *
 * What a row holds: the company, the store, who was refused, the order (when the refusal is about one), the refusal's code and the
 * door that said it. Ids and codes only — never a customer's name, phone or address, never the sentence (the sentence is the code's).
 *
 * The rules of the write:
 *   - NEVER THROWS. A failing insert (the table rolled back, the pool busy, a mocked client) is swallowed: the door answers exactly as it
 *     did before this file existed.
 *   - NEVER INSIDE THE CALLER'S TRANSACTION. It writes through the shared client, as its own statement, after the refusal is decided.
 *   - ONLY THE LISTED CODES. A door hands over whatever code it refused with; anything not in `DESK_REFUSAL_CODES` (an empty queue, a
 *     bad body, a version conflict) writes nothing. `CALL_PROOF_REFUSED` is NOT listed: it already has its audit row.
 *   - ONE ROW A MINUTE PER PRESS. The same person, the same code and the same order (or no order) within `DESK_REFUSAL_FOLD_MS` is
 *     written once — a button hammered ten times is one refusal. Folded twice over: in this process before any statement (so ten
 *     presses at once cost one insert), and in the insert itself (`WHERE NOT EXISTS`, so two server instances agree).
 *
 * Only server route files import this file. The desk's screens never do: its bundle is at its ceiling, and the words of a refusal reach
 * the screen in the door's answer, as they always did.
 */

/** The refusals that are a desk rule catching somebody. Stable codes, the same ones the doors answer with. */
export const DESK_REFUSAL_CODES = [
  // «اسحبي الطلب أول» — she acted on an order she does not hold (confirmation, call log, contact attempt, entry issue).
  'NOT_HELD',
  // «اتصلي أول» — a decision on a held order with no contact attempt.
  'CONTACT_FIRST',
  // The postponement cap.
  'POSTPONE_LIMIT',
  // «لا يرد» typed as a postponement reason while the call plan is on.
  'NO_ANSWER_NOT_A_POSTPONE',
  // The pull's pace.
  'PULL_TOO_FAST',
  // «إيدك مليانة» — the hand limit / the total cap, and the cap on orders not yet called.
  'CAP_TOTAL',
  'CAP_WITHOUT_ATTEMPT',
  // An untouched order in her hands comes before a new one.
  'UNTOUCHED_ORDER',
  // «الشغل أول» — calls she owes come before a new pull.
  'WORK_FIRST',
  // An agent taking an order by its number instead of pulling.
  'USE_THE_PULL',
  // Handing an order to somebody who cannot work it / to another job.
  'CANNOT_WORK_IT',
  'DIFFERENT_RANK',
  // «الزبون على الخط» — the refusals of taking a calling customer's order.
  'HELD_BY_COLLEAGUE',
  'RESERVED_FOR_COLLEAGUE',
  'CLOSED',
  'NEVER_CALLED',
  'REACHED_SINCE_RELEASE',
  'TAKEN_MEANWHILE',
] as const;

export type DeskRefusalCode = (typeof DESK_REFUSAL_CODES)[number];

/** The door that refused — one short stable name per door file. */
export type DeskRefusalDoor =
  | 'pull'
  | 'confirmation'
  | 'contact-attempts'
  | 'claim'
  | 'transfer'
  | 'call-logs'
  | 'callback-take'
  | 'issues';

/** The same person, code and order inside this window is one refusal. */
export const DESK_REFUSAL_FOLD_MS = 60_000;

/** How long a row is kept (the prune job deletes older ones). */
export const DESK_REFUSAL_KEEP_DAYS = 90;

const LOGGED: ReadonlySet<string> = new Set(DESK_REFUSAL_CODES);

/** Is this code one the log keeps? */
export function isLoggedDeskRefusal(code: unknown): code is DeskRefusalCode {
  return typeof code === 'string' && LOGGED.has(code);
}

export interface DeskRefusalEntry {
  companyId: string;
  storeId: string | null;
  userId: string;
  /** The order the refusal is about; null when it is about no order (the pace, a full hand). */
  orderId?: string | null;
  /** Whatever code the door refused with — only the listed ones are written. */
  code: string | null | undefined;
  door: DeskRefusalDoor;
}

/** The narrow piece of a client the write needs — the shared `db` in a door; a fake in a test. */
type RawWriter = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => PromiseLike<number> };

/** Last time each (company, user, code, order) was written by THIS process. Bounded: old keys are dropped when it grows. */
const recent = new Map<string, number>();
const RECENT_MAX = 2_000;

function foldedHere(key: string, nowMs: number): boolean {
  const last = recent.get(key);
  if (last !== undefined && nowMs - last < DESK_REFUSAL_FOLD_MS) return true;
  if (recent.size >= RECENT_MAX) {
    for (const [k, at] of recent) if (nowMs - at >= DESK_REFUSAL_FOLD_MS) recent.delete(k);
    if (recent.size >= RECENT_MAX) recent.clear();
  }
  recent.set(key, nowMs);
  return false;
}


/**
 * Write one refusal row. Answers `true` when a row was written, `false` otherwise (not a listed code, folded, or the write failed).
 * Never throws — await it or not, the door's answer is the same.
 */
export async function logDeskRefusal(entry: DeskRefusalEntry, client: RawWriter = db, now: Date = new Date()): Promise<boolean> {
  try {
    if (!isLoggedDeskRefusal(entry.code)) return false;
    if (!entry.companyId || !entry.userId) return false;
    const orderId = entry.orderId ?? null;
    const nowMs = now.getTime();
    if (foldedHere(`${entry.companyId}|${entry.userId}|${entry.code}|${orderId ?? ''}`, nowMs)) return false;

    // `timestamp(3)` holds UTC wall time (as every Prisma write does): the ISO string cast to `timestamp` drops its «Z», not its hour.
    const at = now.toISOString();
    const since = new Date(nowMs - DESK_REFUSAL_FOLD_MS).toISOString();
    const written = await client.$executeRaw`
      INSERT INTO "desk_refusals" ("id", "companyId", "storeId", "userId", "orderId", "code", "door", "createdAt")
      SELECT ${randomUUID()}::text, ${entry.companyId}::text, ${entry.storeId ?? null}::text, ${entry.userId}::text,
             ${orderId}::text, ${entry.code}::text, ${entry.door}::text, ${at}::timestamp(3)
      WHERE NOT EXISTS (
        SELECT 1 FROM "desk_refusals"
        WHERE "companyId" = ${entry.companyId}::text
          AND "userId" = ${entry.userId}::text
          AND "code" = ${entry.code}::text
          AND "orderId" IS NOT DISTINCT FROM ${orderId}::text
          AND "createdAt" > ${since}::timestamp(3)
      )`;
    return written === 1;
  } catch {
    return false;
  }
}

/** The prune job's query, in bounded passes: delete up to `batch` rows older than the keep window; answers how many went. */
export async function pruneDeskRefusalsOnce(client: RawWriter, now: Date, batch: number): Promise<number> {
  const before = new Date(now.getTime() - DESK_REFUSAL_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return client.$executeRaw`
    DELETE FROM "desk_refusals"
    WHERE "id" IN (
      SELECT "id" FROM "desk_refusals" WHERE "createdAt" < ${before}::timestamp(3) LIMIT ${batch}::int
    )`;
}
