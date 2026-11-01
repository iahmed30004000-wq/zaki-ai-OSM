import { apiJson } from '@/lib/api-client';
import type { DispatchOutcome, DispatchPlan, DispatchSummary } from '@/lib/couriers/dispatch';

/**
 * «رحّل إلى الشركة واجلب الباركود» FOR A BATCH OF ANY SIZE — a few orders at a time, with the count on the button.
 *
 * The send is one order at a time, each a call to the courier, so a batch of a hundred and sixty is minutes. The screen sent it as ONE
 * request and waited fifteen seconds, then said «انتهت مهلة الطلب» while the server went on without it — and the person pressed again,
 * not knowing how far it had got. Now the screen asks which orders are left, sends `DISPATCH_CHUNK` of them per request, waits
 * `DISPATCH_WAIT_MS` for each, and tells the button how far it is.
 *
 * Nothing about WHAT is sent changed: each piece is the same door with `orderIds` (the one already used to retry the ones that
 * failed), so the claim before every call, the skip of a parcel that already has its barcode, and the refusal of a governorate
 * the courier has no id for are all the server's and untouched.
 *
 * IT STOPS AT THE FIRST PIECE THAT FAILS TO ANSWER. A piece that timed out may still be running at the server, and the next one
 * would run beside it. The answer is the partial summary, with every order not yet tried listed as not sent, and a sentence that
 * says to refresh and press again: pressing again is safe, the server skips what already went and what is in flight.
 */

/** Orders per request: small enough that one request is over well inside its wait, large enough that 160 is twenty requests. */
export const DISPATCH_CHUNK = 8;

/** How long ONE piece may take. Eight calls to a courier that answers in a few seconds each; every other request waits fifteen. */
export const DISPATCH_WAIT_MS = 120_000;

export interface DispatchProgress {
  /** Orders handled so far, in this press. */
  done: number;
  /** Orders this press has to send. */
  total: number;
}

/** The send stopped before the end: what it did, and what was left. */
export class DispatchInterrupted extends Error {
  constructor(
    message: string,
    readonly summary: DispatchSummary,
    readonly left: number
  ) {
    super(message);
    this.name = 'DispatchInterrupted';
  }
}

const NOT_TRIED = 'ما انرحّل — وقف الترحيل قبل ما يوصله';

function summarize(outcomes: DispatchOutcome[]): DispatchSummary {
  return {
    sent: outcomes.filter((o) => o.ok).length,
    skipped: outcomes.filter((o) => o.skipped).length,
    failed: outcomes.filter((o) => !o.ok && !o.skipped).length,
    outcomes,
  };
}

export async function dispatchInChunks(batchId: string, onProgress?: (progress: DispatchProgress) => void): Promise<DispatchSummary> {
  const plan = await apiJson<DispatchPlan>(`/api/ops/shipments/${batchId}/dispatch`);

  // What already carries a barcode is answered as the server answers it, so the screen's reading of «something was sent» holds.
  const outcomes: DispatchOutcome[] = plan.sent.map((o) => ({ orderId: o.id, orderNumber: o.orderNumber, ok: false, skipped: 'ALREADY_SENT' }));
  const total = plan.pending.length;
  onProgress?.({ done: 0, total });

  for (let from = 0; from < total; from += DISPATCH_CHUNK) {
    const piece = plan.pending.slice(from, from + DISPATCH_CHUNK);
    try {
      const part = await apiJson<DispatchSummary>(`/api/ops/shipments/${batchId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: piece.map((o) => o.id) }),
        timeoutMs: DISPATCH_WAIT_MS,
      });
      outcomes.push(...part.outcomes);
    } catch (e) {
      const rest = plan.pending.slice(from);
      outcomes.push(...rest.map((o) => ({ orderId: o.id, orderNumber: o.orderNumber, ok: false, error: NOT_TRIED })));
      const why = e instanceof Error ? e.message : 'تعذر الترحيل';
      throw new DispatchInterrupted(
        `وقف الترحيل عند ${from} من ${total}: ${why} حدّث الصفحة وأعد الضغط على «رحّل إلى الشركة» — بيكمل من وين وقف وما بيكرر طرداً.`,
        summarize(outcomes),
        rest.length
      );
    }
    onProgress?.({ done: Math.min(from + DISPATCH_CHUNK, total), total });
  }

  return summarize(outcomes);
}
