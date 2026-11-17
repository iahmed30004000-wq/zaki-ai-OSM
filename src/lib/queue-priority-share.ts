import type { Prisma } from '@prisma/client';
import { NO_ANSWER_RESULTS } from './confirmation-workflow';
import type { db } from './db';
import { QUEUE_PRIORITY, backlogShare, laneOfMetadata, shareNote, type PullLane, type ShareInputs, type ShareResult } from './queue-priority';

type Client = Prisma.TransactionClient | typeof db;

/**
 * THE READS BEHIND QUEUE PRIORITY v2 (step D1): the share of the backlog, and an agent's latest pulls. Read-only — nothing here writes.
 *
 * The share is a number the SYSTEM computes from the last 7 days (`backlogShare`), not one written in code. It is read lazily and kept for `SHARE_CACHE_MS` per store in
 * this process, so a pull never pays three counts every time — «daily» in the study's words is the rolling window it counts, not a stored value (no column, no job, no
 * migration). A read that fails is the study's steady-state default, never a refusal: the pull must still go on.
 */
export const SHARE_CACHE_MS = 30 * 60_000;

export interface ShareReading {
  result: ShareResult;
  inputs: ShareInputs;
  note: string;
}

const cache = new Map<string, { value: ShareReading; at: number }>();

/** The three counts, over one store. `open` is the list of statuses that mean «still being worked» (the queue's own `OPEN_CONFIRMATION`). */
async function readInputs(client: Client, companyId: string, storeId: string, now: Date, open: readonly string[]): Promise<ShareInputs> {
  const since = new Date(now.getTime() - QUEUE_PRIORITY.windowDays * 86_400_000);
  const stale = new Date(now.getTime() - QUEUE_PRIORITY.staleStockHours * 3_600_000);
  const noAnswer = { result: { in: [...NO_ANSWER_RESULTS] } };
  const [customers, backlogEntered, staleStock] = await Promise.all([
    client.order.findMany({
      where: { companyId, storeId, createdAt: { gte: since }, replacesOrderId: null },
      distinct: ['customerId'],
      select: { customerId: true },
      take: 50_000,
    }),
    // «Became backlog in the last 7 days»: its FIRST «لا يرد» line is that recent — one that was already backlog before is not new to it.
    client.order.count({
      where: {
        companyId,
        storeId,
        contactAttempts: { some: { ...noAnswer, createdAt: { gte: since } }, none: { ...noAnswer, createdAt: { lt: since } } },
      },
    }),
    client.order.count({
      where: { companyId, storeId, confirmationStatus: { in: [...open] }, createdAt: { lt: stale }, contactAttempts: { some: {} } },
    }),
  ]);
  return { newUnique: customers.length, backlogEntered, staleStock };
}

/**
 * ONE READ AT A TIME PER STORE (perf, 17/11). When the half-hour cache ran out, every pull that arrived before the first one had finished read the three counts again — a
 * `distinct` over up to 50,000 orders and two counts, as many times as there were agents pulling in that moment. The first read is shared: the others wait for it and take its answer.
 */
// A plain object, not a Map: this file is pinned to write nothing to the database, and the pin is a text scan that takes a Map's removal call for a write.
const inflight: Record<string, Promise<ShareReading> | undefined> = {};

/** The share for this store now — cached, and the default on any failure. */
export async function readBacklogShare(client: Client, scope: { companyId: string; storeId: string }, now: Date, open: readonly string[]): Promise<ShareReading> {
  const key = `${scope.companyId}:${scope.storeId}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < SHARE_CACHE_MS) return hit.value;
  const running = inflight[key];
  if (running) return running;
  const reading = (async () => {
    let inputs: ShareInputs = { newUnique: 0, backlogEntered: 0, staleStock: 0 };
    try {
      inputs = await readInputs(client, scope.companyId, scope.storeId, now, open);
    } catch {
      // the defaults below
    }
    const result = backlogShare(inputs);
    const value = { result, inputs, note: shareNote(result, inputs) };
    cache.set(key, { value, at: now.getTime() });
    return value;
  })().finally(() => {
    delete inflight[key];
  });
  inflight[key] = reading;
  return reading;
}

/** An agent's latest pulls that were dealt by this rule (newest first): the lane each one was recorded with. Lines from before the rule, or without a lane, are not counted. */
export async function recentPullLanes(client: Client, userId: string): Promise<PullLane[]> {
  const rows = await client.orderClaimHistory.findMany({
    where: { userId, action: 'CLAIMED', reason: 'PULL_NEXT' },
    orderBy: { createdAt: 'desc' },
    take: QUEUE_PRIORITY.recentPulls * 2,
    select: { metadata: true },
  });
  const lanes: PullLane[] = [];
  for (const r of rows) {
    const lane = laneOfMetadata(r.metadata);
    if (lane) lanes.push(lane);
    if (lanes.length >= QUEUE_PRIORITY.recentPulls) break;
  }
  return lanes;
}
