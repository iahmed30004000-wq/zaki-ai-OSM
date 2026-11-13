/**
 * ONE TURN FOR EVERYBODY ELSE.
 *
 * The site is one process with one thread. A loop over tens of thousands of rows that never awaits is a site that answers
 * nobody until the loop ends (13/11: the team table held it for 19.5 seconds). `breathe()` hands the thread back for one turn;
 * `breatheEvery(n)` does it once every n rows, so a short loop pays nothing and a long one is never felt.
 *
 * A server-side helper: nothing a browser bundle reaches may import it.
 */
function breathe(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * For a long loop: `const pause = breatheEvery(); … const turn = pause(); if (turn) await turn;` at the top of its body.
 * No promise is made on the turns that do not pause, so a loop of a few hundred rows costs one counter.
 */
export function breatheEvery(every = 2000): () => Promise<void> | undefined {
  let n = 0;
  return () => (++n % every === 0 ? breathe() : undefined);
}
