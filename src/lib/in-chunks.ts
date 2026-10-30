/**
 * ONE ANSWER PER ITEM, A FEW AT A TIME.
 *
 * A draft may name twenty lines, and asking the offers and the shelf of each one after the other made a preview — which the
 * screen asks for at every pause in typing — twenty round trips in a row. All at once would be twenty connections from one
 * keystroke; five at a time is both. Only for READS: the order of anything that takes a lock is not this function's to change.
 */
const AT_A_TIME = 5;

export async function inChunks<T, R>(items: readonly T[], ask: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += AT_A_TIME) {
    out.push(...(await Promise.all(items.slice(i, i + AT_A_TIME).map(ask))));
  }
  return out;
}
