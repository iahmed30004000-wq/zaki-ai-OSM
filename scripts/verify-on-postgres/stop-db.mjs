/**
 * Removes the throwaway PostgreSQL of the verification kit: the container `zaki-scratch-pg` AND its volume `zaki-scratch-pg-data`.
 *
 * DEFINITION OF DONE: removes exactly those two names (constants of `lib.mjs`, never a pattern, never an argument), is a no-op when
 * they are already gone, and touches nothing else on the machine — another project's container or volume is never listed, stopped
 * or removed.
 *
 *   node scripts/verify-on-postgres/stop-db.mjs
 */
import { CONTAINER, VOLUME, containerState, docker, volumeExists } from './lib.mjs';

if (containerState() !== 'absent') {
  docker(['rm', '-f', CONTAINER]);
  console.log(`[stop-db] الحاوية ${CONTAINER} انشالت.`);
} else {
  console.log(`[stop-db] الحاوية ${CONTAINER} مش موجودة.`);
}
if (volumeExists()) {
  docker(['volume', 'rm', VOLUME]);
  console.log(`[stop-db] الـvolume ${VOLUME} انشال.`);
} else {
  console.log(`[stop-db] الـvolume ${VOLUME} مش موجود.`);
}
