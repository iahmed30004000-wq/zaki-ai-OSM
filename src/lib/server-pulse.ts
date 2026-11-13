/**
 * THE PULSE — A SERVER THAT STOPS ANSWERING NAMES WHAT IT WAS DOING (the owner, 13/11).
 *
 *   «السايت بيعلّق» — and for weeks there was nothing to read: a freeze of fifteen seconds left no line in any log, so every
 *   cause was a guess until one was measured from outside.
 *
 * The site is one process with one thread. A timer that should fire every 100 ms and fires FIFTEEN SECONDS late IS a stalled
 * server, measured from the inside: the gap is how long nobody was answered. So one such timer runs for the life of the
 * process; when it fires late (`STALL_MS`) it writes ONE line to the container's log and remembers the stall, together with the
 * names of the computations that were running at that moment (`labelled`).
 *
 * WHAT IS RECORDED: a duration, a time, and OUR OWN words for a computation (`report:team`, …). Never a URL, a query, an id, a
 * name or a phone number: this is read by the owner's own door (`/api/admin/pulse`) and written to a log that is not his.
 *
 * Server-side only. State lives on `globalThis`, as the database clients do, because a production build evaluates a module once
 * per bundle and the timer, the stalls and the running list must be one thing.
 */

/** A timer that comes later than this many milliseconds past its time is written down. */
const STALL_MS = 250;
/** A labelled computation that takes longer than this is remembered as slow. */
const SLOW_MS = 2000;
const TICK_MS = 100;
/** How many of each are remembered; the oldest drops. */
const KEEP = 100;
const HOUR_MS = 60 * 60 * 1000;

interface Stall {
  at: string;
  ms: number;
  running: string[];
}
interface Slow {
  at: string;
  label: string;
  ms: number;
}
interface Pulse {
  startedAt: number;
  last: number;
  stalls: Stall[];
  slow: Slow[];
  running: Map<number, { label: string; since: number }>;
  seq: number;
  timer: ReturnType<typeof setInterval> | null;
}

const shared = globalThis as unknown as { __osmPulse?: Pulse };

function pulse(): Pulse {
  return (shared.__osmPulse ??= {
    startedAt: Date.now(),
    last: performance.now(),
    stalls: [],
    slow: [],
    running: new Map(),
    seq: 0,
    timer: null,
  });
}

/**
 * Start the heartbeat — once. A second call (a hot reload, a second bundle) finds the timer running and does nothing.
 * `now` is for a test that has to make a tick arrive late without blocking anything.
 */
export function startPulse(now: () => number = () => performance.now()): void {
  const p = pulse();
  if (p.timer) return;
  p.last = now();
  p.timer = setInterval(() => {
    const at = now();
    const late = at - p.last - TICK_MS;
    p.last = at;
    if (late < STALL_MS) return;
    const running = [...new Set([...p.running.values()].map((r) => r.label))];
    p.stalls.push({ at: new Date().toISOString(), ms: Math.round(late), running });
    if (p.stalls.length > KEEP) p.stalls.shift();
    // One line: a duration and the names of our own computations — nothing a customer, a request or a person could be read from.
    console.warn(`[pulse] the server answered nobody for ${Math.round(late)} ms; running: ${running.join(', ') || 'nothing labelled'}`);
  }, TICK_MS);
  // The timer must never be what keeps the process alive.
  p.timer.unref?.();
}

/**
 * Run `work` under a name, so that a stall that happens meanwhile can say what was running. It changes neither the result nor
 * the error, and it is always taken off the list again.
 */
export async function labelled<T>(label: string, work: () => Promise<T>): Promise<T> {
  const p = pulse();
  const id = ++p.seq;
  const since = performance.now();
  p.running.set(id, { label, since });
  try {
    return await work();
  } finally {
    p.running.delete(id);
    const ms = performance.now() - since;
    if (ms >= SLOW_MS) {
      p.slow.push({ at: new Date().toISOString(), label, ms: Math.round(ms) });
      if (p.slow.length > KEEP) p.slow.shift();
    }
  }
}

/** Node's clock has `eventLoopUtilization`; the DOM type the global `performance` is declared with does not know it. */
const nodeClock = performance as Performance & { eventLoopUtilization?: () => { utilization: number } };

/** What the owner's door answers: numbers, times and our own words. */
export function pulseReport() {
  const p = pulse();
  const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
  const mem = process.memoryUsage();
  const recent = p.stalls.filter((s) => Date.now() - Date.parse(s.at) < HOUR_MS);
  return {
    uptimeSeconds: Math.round((Date.now() - p.startedAt) / 1000),
    memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external) },
    /** The share of its life the loop has been busy (0 to 1) — a cumulative figure, since the process started. */
    eventLoopUtilization: typeof nodeClock.eventLoopUtilization === 'function' ? Math.round(nodeClock.eventLoopUtilization().utilization * 1000) / 1000 : null,
    stallsLastHour: recent.length,
    worstStallMsLastHour: recent.reduce((worst, s) => Math.max(worst, s.ms), 0),
    stalls: [...p.stalls].reverse(),
    slow: [...p.slow].reverse(),
    runningNow: [...new Set([...p.running.values()].map((r) => r.label))],
    watching: p.timer !== null,
  };
}
