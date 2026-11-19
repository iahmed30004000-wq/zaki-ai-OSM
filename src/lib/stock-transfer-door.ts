import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { db } from './db';
import { requireContext } from './geo-context';
import { apiErrorResponse } from './api-error';
import { logAudit } from './audit';
import { reachesWarehouse } from './warehouses';
import { StockTransferRefused, refusalBody, shownTo, type StockTransferRow } from './stock-transfers';
import type { WarehouseRef } from './warehouse-intake';
import { SplitRefused } from './batch-split';
import type { Prisma } from '@prisma/client';

/**
 * What the three doors of ONE transfer share (`/api/inventory/transfers/:id/receive`, `/cancel`, `/difference`): the
 * session (the store the caller stands in, her key, the warehouses she reaches), the body, one transaction, the Arabic
 * refusal, and the audit line. Every rule is in `stock-transfers.ts`; this file only carries the session to it.
 */

export const refuse = (status: number, code: string, ar: string) => NextResponse.json({ error: ar, errorAr: ar, code }, { status });

/**
 * A refusal of the lib — or of the split under it (a batch changed between the read and the write) — as the Arabic
 * answer; anything else is not a refusal and goes on to the generic error answer.
 */
export function refusalOf(e: unknown): NextResponse | null {
  if (e instanceof StockTransferRefused) return NextResponse.json(refusalBody(e), { status: e.status });
  if (e instanceof SplitRefused) return refuse(409, 'MOVED_MEANWHILE', e.errorAr);
  return null;
}

/** The session's own reach rule, for the lib to ask about a warehouse (`warehouses.reachesWarehouse`). */
export const reachFor =
  (user: Parameters<typeof reachesWarehouse>[0], companyId: string) =>
  (w: WarehouseRef): Promise<boolean> =>
    reachesWarehouse(user, companyId, w);

/** One transaction long enough for a transfer of a few hundred lines; a timeout rolls everything back. */
export const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

export async function transferAction<S extends z.ZodTypeAny>(
  req: Request,
  params: Promise<{ id: string }>,
  spec: {
    /** The door's own key, asked as a literal call in the route (the permissions-screen guard reads it there). */
    gate: () => Promise<unknown>;
    schema: S;
    audit: string;
    run: (
      tx: Prisma.TransactionClient,
      p: { companyId: string; storeId: string; transferId: string; userId: string; body: z.infer<S>; mayUse: (w: WarehouseRef) => Promise<boolean> }
    ) => Promise<{ transfer: StockTransferRow; replay: boolean }>;
  }
) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await spec.gate();

    const parsed = spec.schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', parsed.error.issues[0]?.message ?? 'البيانات ناقصة');

    try {
      const out = await db.$transaction(
        (tx) => spec.run(tx, { companyId, storeId, transferId: id, userId: user.id, body: parsed.data, mayUse: reachFor(user, companyId) }),
        TX_OPTIONS
      );
      if (!out.replay) {
        await logAudit({
          companyId,
          userId: user.id,
          action: spec.audit,
          entity: 'StockTransfer',
          entityId: id,
          newData: { status: out.transfer.status, lines: out.transfer.lines, by: user.name },
        });
      }
      return NextResponse.json({ transfer: shownTo(out.transfer, user.id), replay: out.replay });
    } catch (e) {
      const refused = refusalOf(e);
      if (refused) return refused;
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
