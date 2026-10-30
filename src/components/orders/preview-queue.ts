import { PARALLEL_CHECKS } from '@/lib/change-request-review';

/**
 * AT MOST THREE CHECKS IN THE AIR AT ONCE, for the whole page.
 *
 * Each card of «بانتظار التطبيق» asks the server for its own check. Started together, forty cards are forty requests on
 * the same second and a budget spent before the page has finished drawing; started three at a time they arrive as fast as the
 * server answers and none waits long. A task that has to wait is handed the slot of the one that finishes — no gap in
 * which a newcomer could slip in front.
 */
let active = 0;
const waiting: Array<() => void> = [];

export async function throttled<T>(task: () => Promise<T>): Promise<T> {
  if (active < PARALLEL_CHECKS) active += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}
