/**
 * RUNS ONCE, WHEN THE SERVER STARTS (Next's `register` hook — node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
 *
 * It starts the pulse (`lib/server-pulse.ts`): a timer that should fire every 100 ms and fires fifteen seconds late IS a stalled
 * server, measured, and the next stall names itself in the log and at `/api/admin/pulse`. The check on the runtime is the
 * framework's own advice: `register` is called for every runtime, and the pulse is for the Node one.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startPulse } = await import('./lib/server-pulse');
    startPulse();
  }
}
