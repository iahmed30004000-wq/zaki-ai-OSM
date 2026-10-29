import { NextResponse } from 'next/server';

/**
 * GET /api/health/live — IS THE PROCESS ALIVE. NOTHING ELSE.
 *
 * This is what the container's own `HEALTHCHECK` (the Dockerfile) asks. It
 * answers from memory: no database, no worker, no file, no other service.
 *
 * ── WHY THE CONTAINER'S CHECK MUST NOT ASK THE DATABASE ──
 *
 * The question a container health check answers is «should this process be
 * restarted, or pulled out of rotation?». A slow or briefly unreachable
 * database is not a reason to do either: the restart does not fix the
 * database, and a container that is marked unhealthy is a container the
 * proxy stops sending visitors to — so a database that is merely slow
 * turned into a website that was down, three failed checks in a row later.
 * A check that restarts the wrong thing manufactures the outage it was
 * added to catch (the same reasoning that keeps a dead worker out of
 * `/api/health`).
 *
 * So the two questions have two doors:
 *
 *   /api/health/live  the process answers          → the container's check
 *   /api/health       the app can do its job (DB)  → the uptime monitor, and
 *                                                    the path Coolify's own
 *                                                    health-check setting names
 *   /api/health/worker  the scheduler is alive     → its own monitor
 *
 * NO SESSION, LEAKS NOTHING, NEVER CACHED — the rules of `../route.ts`,
 * which are absolute for every route in this folder. The body is one fixed
 * word.
 */
export const dynamic = 'force-dynamic';

const HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200, headers: HEADERS });
}
