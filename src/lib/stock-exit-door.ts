import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { db } from './db';
import { requireContext } from './geo-context';
import { apiErrorResponse } from './api-error';
import { logAudit } from './audit';
import { maySeeCost } from './cost-visibility';
import { StockExitRefused, exitRefusalBody, exitShown, type StockExitRow } from './stock-exits';
import { reachFor, refuse, TX_OPTIONS } from './stock-transfer-door';
import type { WarehouseRef } from './warehouse-intake';
import type { Prisma } from '@prisma/client';

/**
 * What the two doors of ONE exit share (`/api/inventory/exits/:id/approve`, `/reject`): the session (the store the
 * caller stands in, her key, the warehouses she reaches), the body, one transaction, the Arabic refusal, and the audit
 * line. Every rule is in `stock-exits.ts`; this file only carries the session to it. The session's helpers (`refuse`,
 * `reachFor`, the transaction's options) are the transfer doors' own (`stock-transfer-door.ts`) — one of each.
 */

/** A refusal of the lib as the Arabic answer; anything else is not a refusal and goes on to the generic error answer. */
export function exitRefusalOf(e: unknown): NextResponse | null {
  if (e instanceof StockExitRefused) return NextResponse.json(exitRefusalBody(e), { status: e.status });
  return null;
}

export async function exitAction<S extends z.ZodTypeAny>(
  req: Request,
  params: Promise<{ id: string }>,
  spec: {
    /** The door's own key, asked as a literal call in the route (the permissions-screen guard reads it there). */
    gate: () => Promise<unknown>;
    schema: S;
    audit: string;
    run: (
      tx: Prisma.TransactionClient,
      p: { companyId: string; storeId: string; exitId: string; userId: string; body: z.infer<S>; mayUse: (w: WarehouseRef) => Promise<boolean> }
    ) => Promise<{ exit: StockExitRow; replay: boolean }>;
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
        (tx) => spec.run(tx, { companyId, storeId, exitId: id, userId: user.id, body: parsed.data, mayUse: reachFor(user, companyId) }),
        TX_OPTIONS
      );
      if (!out.replay) {
        await logAudit({
          companyId,
          userId: user.id,
          action: spec.audit,
          entity: 'StockExit',
          entityId: id,
          // Quantities only: the value at cost is not copied into the audit trail, which people without the cost key read.
          newData: { status: out.exit.status, reason: out.exit.reason, lines: out.exit.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), by: user.name },
        });
      }
      return NextResponse.json({ exit: exitShown(out.exit, maySeeCost(user)), replay: out.replay });
    } catch (e) {
      const refused = exitRefusalOf(e);
      if (refused) return refused;
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
