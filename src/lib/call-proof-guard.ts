import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import type { db } from './db';
import { logAudit } from './audit';
import { callProofVerdict, pairedLineVerdict } from './call-proof';
import { CALL_PROOF_WORDS } from './call-proof-words';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «إثبات المكالمات» — THE SERVICE-LAYER HALF (Confirmation Center v2, step A). Every door an agent can reach that records a «didn't answer» asks
 * `assertCallProven` BEFORE it writes anything, inside the same transaction as the write, and only when the company switch is on (`call-proof-switch.ts`;
 * the caller reads it once, and OFF means this file is never called). The rule itself is `call-proof.ts`.
 *
 * A refusal is a SENTINEL thrown inside the transaction — nothing is written, the transaction rolls back, no close and no release follow — and answered
 * in the door's `catch` by `answerCallProofRefusal` as a 409 she can act on (never a 500), with one audit row written after the rollback.
 *
 * Two doors, two questions (`door`):
 *   · `ATTEMPT` — the contact-attempts door, which WRITES the line: is there a «اتصال» press of hers, since she took the order and since the last outcome, at
 *     least thirty seconds old? (Also the follow-up door when the reason is «لا يرد», where no line is written.)
 *   · `STATUS`  — the confirmation door's `contact_result`, which only moves the status to «لا يرد»: is her own line of this result already the order's newest
 *     outcome? (The thirty seconds were enforced when that line was written.)
 * ═══════════════════════════════════════════════════════════════════════
 */

export type CallProofRefusalCode = 'CALL_NOT_STARTED' | 'CALL_TOO_SOON' | 'CALL_NOT_LOGGED';

export class CallProofRefusal extends Error {
  constructor(
    readonly code: CallProofRefusalCode,
    readonly ctx: { companyId: string; orderId: string; employeeId: string; result: string; door: 'ATTEMPT' | 'STATUS' },
    readonly wait?: { waitSeconds: number; unlocksAtMs: number }
  ) {
    super(code);
    this.name = 'CallProofRefusal';
  }
}

export interface AssertCallProvenArgs {
  companyId: string;
  orderId: string;
  employeeId: string;
  /** `Order.claimedAt` — the floor under the press that counts. */
  claimedAt: Date | null;
  result: string;
  door: 'ATTEMPT' | 'STATUS';
  now?: Date;
}

/**
 * Throws `CallProofRefusal` when the result may not be recorded now; otherwise resolves with the server-measured seconds from the press to now (door `ATTEMPT`,
 * guarded class only — `null` for everything else, and `null` means «not measured»).
 */
export async function assertCallProven(client: Client, args: AssertCallProvenArgs): Promise<{ durationSeconds: number | null }> {
  const now = args.now ?? new Date();
  const attempts = await client.orderContactAttempt.findMany({
    where: { orderId: args.orderId, companyId: args.companyId },
    select: { createdAt: true, result: true, employeeId: true, attemptNumber: true },
  });
  const ctx = { companyId: args.companyId, orderId: args.orderId, employeeId: args.employeeId, result: args.result, door: args.door };
  if (args.door === 'STATUS') {
    const paired = pairedLineVerdict({ attempts, employeeId: args.employeeId, claimedAt: args.claimedAt, result: args.result, now });
    if (!paired.ok) throw new CallProofRefusal(paired.code === 'NO_OPENED' ? 'CALL_NOT_STARTED' : 'CALL_NOT_LOGGED', ctx);
    return { durationSeconds: null };
  }
  const verdict = callProofVerdict({ attempts, employeeId: args.employeeId, claimedAt: args.claimedAt, result: args.result, now });
  if (!verdict.ok) {
    if (verdict.code === 'NO_OPENED') throw new CallProofRefusal('CALL_NOT_STARTED', ctx);
    throw new CallProofRefusal('CALL_TOO_SOON', ctx, { waitSeconds: verdict.waitSeconds, unlocksAtMs: verdict.unlocksAtMs });
  }
  return { durationSeconds: verdict.elapsedSeconds };
}

/** The 409 body of a refusal — English for the logs, Arabic for the agent, the code for the screens. */
export function callProofBody(refusal: CallProofRefusal): Record<string, unknown> {
  if (refusal.code === 'CALL_TOO_SOON' && refusal.wait) {
    const errorAr = CALL_PROOF_WORDS.refusedTooSoon(refusal.wait.waitSeconds);
    return {
      error: 'A «no answer» needs a logged «call» press at least 30 seconds old.',
      errorAr,
      code: refusal.code,
      waitSeconds: refusal.wait.waitSeconds,
      unlocksAt: new Date(refusal.wait.unlocksAtMs).toISOString(),
    };
  }
  if (refusal.code === 'CALL_NOT_LOGGED') {
    return { error: 'Record the call attempt first, then change the status.', errorAr: CALL_PROOF_WORDS.notLogged, code: refusal.code };
  }
  return { error: 'No «call» press is logged on this order.', errorAr: CALL_PROOF_WORDS.refusedNotStarted, code: 'CALL_NOT_STARTED' };
}

/**
 * The door's `catch`: a `CallProofRefusal` becomes a 409 and one `CALL_PROOF_REFUSED` audit row (written after the rollback, so it is the only trace a refusal
 * leaves); anything else is `null` and the door answers as it always did. A failing audit write never changes the answer.
 */
export async function answerCallProofRefusal(error: unknown): Promise<NextResponse | null> {
  if (!(error instanceof CallProofRefusal)) return null;
  try {
    await logAudit({
      companyId: error.ctx.companyId,
      userId: error.ctx.employeeId,
      action: 'CALL_PROOF_REFUSED',
      entity: 'Order',
      entityId: error.ctx.orderId,
      newData: {
        code: error.code,
        result: error.ctx.result,
        door: error.ctx.door,
        ...(error.wait ? { waitSeconds: error.wait.waitSeconds } : {}),
      },
    });
  } catch {
    /* the refusal stands without its audit row */
  }
  return NextResponse.json(callProofBody(error), { status: 409 });
}
