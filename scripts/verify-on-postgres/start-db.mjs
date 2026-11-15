/**
 * Starts (or reuses) the throwaway PostgreSQL for the verification kit and creates the database `scratch_zaki`.
 *
 * DEFINITION OF DONE: idempotent — a second run changes nothing and says so; the container `zaki-scratch-pg` is published ONLY on
 * 127.0.0.1:54329; the password is generated here, passed through the docker child's environment (not argv), and written nowhere;
 * the script returns only when PostgreSQL accepts connections and `scratch_zaki` exists. No image is pulled (the image must already
 * be present: this kit downloads nothing).
 *
 *   node scripts/verify-on-postgres/start-db.mjs
 */
import {
  CONTAINER, DB_NAME, DB_USER, HOST, IMAGE, PORT, VOLUME,
  containerState, die, docker, newPassword, psql, redacted, scratchUrl, sleep, volumeExists,
} from './lib.mjs';

const state = containerState();

if (state === 'absent') {
  // The image must already be here — never pull anything from this script.
  if (docker(['image', 'inspect', IMAGE], { allowFail: true }).code !== 0) {
    die(`الصورة ${IMAGE} مش موجودة محلياً — الكيت ما بينزّل شي. نزّلها بإيدك مرة (docker pull ${IMAGE}) وأعد التشغيل.`);
  }
  // A volume left behind by a container someone removed by hand still holds the OLD password; PostgreSQL only reads the new one
  // into an EMPTY data directory. The volume is ours (fixed name) and scratch by definition, so it is removed first.
  if (volumeExists()) {
    console.log(`[start-db] volume ${VOLUME} موجود بلا حاوية — بيتشال قبل ما نبدأ (بيحمل كلمة سر قديمة).`);
    docker(['volume', 'rm', VOLUME]);
  }
  const password = newPassword();
  docker(
    [
      'run', '-d',
      '--name', CONTAINER,
      '--restart', 'no',
      // Published on the loopback address only — never on 0.0.0.0.
      '-p', `${HOST}:${PORT}:5432`,
      '-v', `${VOLUME}:/var/lib/postgresql/data`,
      // `-e NAME` with no value: docker takes it from ITS environment, so the password is not in argv (nor in `ps`).
      '-e', 'POSTGRES_PASSWORD',
      '-e', `POSTGRES_USER=${DB_USER}`,
      '-e', 'POSTGRES_DB=postgres',
      '--label', 'zaki.scratch=1',
      IMAGE,
    ],
    { env: { POSTGRES_PASSWORD: password } }
  );
  console.log(`[start-db] الحاوية ${CONTAINER} انعملت (${IMAGE}) على ${HOST}:${PORT}.`);
} else if (state === 'stopped') {
  docker(['start', CONTAINER]);
  console.log(`[start-db] الحاوية ${CONTAINER} كانت واقفة — اشتغلت.`);
} else {
  console.log(`[start-db] الحاوية ${CONTAINER} شغّالة أصلاً.`);
}

// Wait until PostgreSQL really accepts connections. The official image starts a temporary server for its init scripts and then
// restarts, so `pg_isready` can answer «yes» once before the real server is up — require it twice in a row.
let ready = 0;
for (let i = 0; i < 90 && ready < 2; i++) {
  const r = docker(['exec', CONTAINER, 'pg_isready', '-U', DB_USER, '-d', 'postgres'], { allowFail: true });
  ready = r.code === 0 ? ready + 1 : 0;
  if (ready < 2) await sleep(1000);
}
if (ready < 2) die('PostgreSQL ما جاوب خلال 90 ثانية. شوف: docker logs zaki-scratch-pg');

const exists = psql(`SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'`).out === '1';
if (!exists) {
  psql(`CREATE DATABASE ${DB_NAME}`);
  console.log(`[start-db] القاعدة ${DB_NAME} انعملت.`);
} else {
  console.log(`[start-db] القاعدة ${DB_NAME} موجودة.`);
}

const version = psql('SHOW server_version', DB_NAME).out;
console.log(`[start-db] جاهز — PostgreSQL ${version} على ${redacted(scratchUrl())}`);
