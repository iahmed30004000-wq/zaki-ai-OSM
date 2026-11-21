import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { db } from './db';
import { requireContext } from './geo-context';
import { apiErrorResponse } from './api-error';
import { logAudit } from './audit';
import { can } from './authorization';
import { maySeeCost } from './cost-visibility';
import { IntakePlaceRefused, intakeRefusalBody, type WarehouseRef } from './warehouse-intake';
import { StockCountRefused, countRefusalBody, countShown, type StockCountRow } from './stock-counts';
import { arabicIssue, reachFor, refuse, TX_OPTIONS } from './stock-transfer-door';
import type { SessionUser } from '@/types/auth';

/**
 * What the doors of ONE count sheet share (`/api/inventory/counts/:id`, `/submit`, `/approve`, `/void`): the session (the
 * store the caller stands in, her keys, the warehouses she reaches), the body, one transaction, the Arabic refusal, the
 * audit line, and — above all — WHAT THE ANSWER MAY SHOW: `shownFor`. Every rule is in `stock-counts.ts`.
 */

/**
 * THE BLIND RULE, decided once, by the session's own keys: only a holder of `inventory.count_approve` is ever told what
 * the book holds. A holder of `inventory.count` without it — the keeper who counts — gets her own figures and nothing
 * else, from every door of the sheet. (Anybody else who may read the sheets is told no more than the keeper.)
 */
export function shownFor(user: SessionUser, c: StockCountRow) {
  return countShown(c, { seesExpected: can(user, 'inventory.count_approve'), seesCost: maySeeCost(user) });
}

/** A refusal of the lib — or of the intake under the approval's surplus — as the Arabic answer; anything else is not one. */
export function countRefusalOf(e: unknown): NextResponse | null {
  if (e instanceof StockCountRefused) return NextResponse.json(countRefusalBody(e), { status: e.status });
  if (e instanceof IntakePlaceRefused) return NextResponse.json(intakeRefusalBody(e), { status: e.status });
  // Two presses that both read «no open sheet» and both wrote one: the partial unique index let only one through.
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const ar = new StockCountRefused('COUNT_ALREADY_OPEN');
    return NextResponse.json(countRefusalBody(ar), { status: ar.status });
  }
  // A submit runs in one snapshot (REPEATABLE READ): a sheet changed under it is answered «try again», never a 500.
  if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2034' || e.code === 'P2028')) {
    const ar = new StockCountRefused('MOVED_MEANWHILE');
    return NextResponse.json(countRefusalBody(ar), { status: ar.status });
  }
  return null;
}

export async function countAction<S extends z.ZodTypeAny>(
  req: Request,
  params: Promise<{ id: string }>,
  spec: {
    /** The door's own key, asked as a literal call in the route (the permissions-screen guard reads it there). */
    gate: (user: SessionUser) => Promise<unknown>;
    schema: S;
    audit: string;
    /** Prisma's transaction options — the submit asks for one snapshot (REPEATABLE READ). */
    txOptions?: { timeout: number; maxWait: number; isolationLevel?: Prisma.TransactionIsolationLevel };
    run: (
      tx: Prisma.TransactionClient,
      p: {
        companyId: string;
        storeId: string;
        countId: string;
        userId: string;
        user: SessionUser;
        body: z.infer<S>;
        mayUse: (w: WarehouseRef) => Promise<boolean>;
      }
    ) => Promise<{ count: StockCountRow; replay: boolean }>;
  }
) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    await spec.gate(user);

    const parsed = spec.schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', arabicIssue(parsed.error));

    try {
      const out = await db.$transaction(
        (tx) => spec.run(tx, { companyId, storeId, countId: id, userId: user.id, user, body: parsed.data, mayUse: reachFor(user, companyId) }),
        spec.txOptions ?? TX_OPTIONS
      );
      if (!out.replay) {
        await logAudit({
          companyId,
          userId: user.id,
          action: spec.audit,
          entity: 'StockCount',
          entityId: id,
          // No figure of the book: the audit trail is read by people the blind rule does not know about.
          newData: { status: out.count.status, warehouseId: out.count.warehouseId, lines: out.count.lines.length, by: user.name },
        });
      }
      return NextResponse.json({ count: shownFor(user, out.count), replay: out.replay });
    } catch (e) {
      const refused = countRefusalOf(e);
      if (refused) return refused;
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
