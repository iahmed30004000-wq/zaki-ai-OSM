import { db } from './db';

/**
 * THE RESPONSE CLOCK.
 *
 * An order sitting claimed and untouched is the most expensive thing on the
 * confirmation desk: the customer ordered minutes ago, is still warm, and
 * every hour that passes turns a sale into a "I changed my mind". Pulling an
 * order out of the pool and not calling is worse than leaving it in the
 * pool, because nobody else can take it.
 *
 * So the agent sees two clocks, and both are also averaged into her
 * performance:
 *
 *   PER ORDER — how long from pulling it to the first thing she did about
 *   it. This is the number the customer feels.
 *
 *   SINCE THE LAST PULL — how long since she took anything new. An agent
 *   with an empty desk and a full pool is idle; an agent holding twelve
 *   open orders is not.
 *
 * "The first thing she did" means a logged contact attempt or a recorded
 * confirmation decision, whichever came first. Opening the screen is not an
 * action: a clock that stops when somebody looks at a row measures nothing.
 */

/**
 * The confirmation statuses a PERSON's decision writes after she has done something about the order.
 *
 * NOT `NEW` (the order's creation, or its release back to the pool) and NOT `IN_PROGRESS`: the pull writes that one the instant
 * it claims the order (`pullNextOrder`, the line «سحب من الطابور»). Counting it made every pulled order read «رددت خلال الآن»
 * whatever she did — and the «بانتظار أول اتصال» chip, which only shows while there is NO first action, could never show.
 */
const DECISION_STATUSES = ['NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED', 'CONFIRMED', 'REJECTED', 'CANCELLED'] as const;

/**
 * The first recorded action on each of these orders.
 *
 * Two sources because either can come first: an agent who calls and logs a
 * no-answer has an attempt and no decision; an agent who confirms straight
 * away has a decision and no attempt. Being pulled is neither.
 */
export async function firstActionTimes(orderIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (orderIds.length === 0) return out;

  const [attempts, decisions] = await Promise.all([
    db.orderContactAttempt.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orderIds } },
      _min: { createdAt: true },
    }),
    db.orderStatusLog.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orderIds }, statusType: 'CONFIRMATION', newValue: { in: [...DECISION_STATUSES] } },
      _min: { createdAt: true },
    }),
  ]);

  const keep = (orderId: string, at: Date | null) => {
    if (!at) return;
    const known = out.get(orderId);
    if (!known || at < known) out.set(orderId, at);
  };
  for (const a of attempts) keep(a.orderId, a._min.createdAt);
  for (const d of decisions) keep(d.orderId, d._min.createdAt);

  return out;
}
