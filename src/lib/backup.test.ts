import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupHealth, backupName, prune } from './backup';
import { repoFile, stripComments } from './guard-source';

/**
 * A BACKUP, AND KNOWING IT IS ONE.
 *
 * `DEPLOY.md` already told the operator to run `pg_dump` before a deploy.
 * That is the right command and the wrong schedule: a backup taken when
 * somebody remembers is a backup that exists on the days nothing went wrong.
 *
 * What is tested here is everything that does NOT need a database: the
 * health report, the pruning, and the two facts about the command that a
 * reader cannot check by running it. Taking and restoring a real dump is the
 * DRILL, and a drill is a thing a person watches — `scripts/restore-drill.ts`.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zaki-backup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.BACKUP_UPLOAD_CMD;
});

/** A dump file of a given age and size. */
async function fakeDump(name: string, bytes: number, ageHours = 0) {
  const path = join(dir, name);
  await writeFile(path, Buffer.alloc(bytes, 1));
  const when = new Date(Date.now() - ageHours * 3_600_000);
  await utimes(path, when, when);
  return path;
}

describe('the health report', () => {
  const NOW = new Date('2026-10-01T12:00:00Z');

  it('says so when there is not one backup', async () => {
    const h = await backupHealth({ dir, now: NOW });
    expect(h.count).toBe(0);
    expect(h.latest).toBeNull();
    expect(h.problems.join(' ')).toContain('لا نسخة احتياطية واحدة');
  });

  it('and when the folder does not exist at all', async () => {
    const h = await backupHealth({ dir: join(dir, 'nope'), now: NOW });
    expect(h.problems.join(' ')).toContain('لا نسخة احتياطية واحدة');
  });

  /**
   * A DAILY JOB THAT STOPPED IS THE FAILURE THIS EXISTS TO CATCH.
   *
   * The folder is full, every file is a real dump, and none of them is from
   * this week. Counting files would report health.
   */
  it('reports a stale backup even when the folder is full', async () => {
    await fakeDump('zaki-a.dump', 5000, 24 * 9);
    await fakeDump('zaki-b.dump', 5000, 24 * 8);
    const h = await backupHealth({ dir, now: new Date() });
    expect(h.count).toBe(2);
    expect(h.problems.join(' ')).toContain('لا تعمل');
  });

  it('reports an almost-empty dump, which is the shape of a failed one', async () => {
    await fakeDump('zaki-a.dump', 40);
    const h = await backupHealth({ dir, now: new Date() });
    expect(h.problems.join(' ')).toContain('شبه فارغة');
  });

  /**
   * AND «ON THE SERVER» IS REPORTED AS A PROBLEM, NOT AS GREEN.
   *
   * A dump beside the database it came from survives a dropped table and
   * nothing else: not the disk, not the machine, not the provider. The brief
   * asks for off-server, and until somebody says where, this must not read
   * as healthy.
   */
  it('refuses to call a local-only backup healthy', async () => {
    await fakeDump('zaki-a.dump', 5000);
    const h = await backupHealth({ dir, now: new Date() });
    expect(h.offSite).toBe(false);
    expect(h.problems.join(' ')).toContain('على الخادم نفسه');

    process.env.BACKUP_UPLOAD_CMD = 'rclone copy';
    const h2 = await backupHealth({ dir, now: new Date() });
    expect(h2.offSite).toBe(true);
    expect(h2.problems, 'ما زال يشتكي رغم ضبط الوجهة').toEqual([]);
  });

  it('names the newest one, not the first it read', async () => {
    await fakeDump('zaki-2026-01-01.dump', 5000, 48);
    await fakeDump('zaki-2026-06-01.dump', 6000, 1);
    const h = await backupHealth({ dir, now: new Date() });
    expect(h.latest?.file).toBe('zaki-2026-06-01.dump');
  });
});

describe('pruning', () => {
  /** A folder that grows for ever fills the disk the database is on. */
  it('keeps the newest and removes the rest', async () => {
    for (let i = 1; i <= 20; i++) {
      await fakeDump(`zaki-${String(i).padStart(3, '0')}.dump`, 100);
    }
    const removed = await prune(dir);
    const left = (await readdir(dir)).sort();
    expect(removed).toBe(6);
    expect(left).toHaveLength(14);
    expect(left[0]).toBe('zaki-007.dump');
    expect(left.at(-1)).toBe('zaki-020.dump');
  });

  it('touches nothing that is not a dump', async () => {
    await mkdir(join(dir, 'keep'), { recursive: true });
    await writeFile(join(dir, 'notes.txt'), 'x');
    for (let i = 1; i <= 20; i++) await fakeDump(`zaki-${String(i).padStart(3, '0')}.dump`, 100);
    await prune(dir);
    const left = await readdir(dir);
    expect(left).toContain('notes.txt');
    expect(left).toContain('keep');
  });

  it('and a name sorts by the moment it was taken', () => {
    const a = backupName(new Date('2026-09-30T23:00:00Z'));
    const b = backupName(new Date('2026-10-01T01:00:00Z'));
    expect([b, a].sort()).toEqual([a, b]);
    expect(a.endsWith('.dump')).toBe(true);
  });
});

describe('the command it runs', () => {
  /**
   * THE CONNECTION STRING NEVER GOES ON THE COMMAND LINE.
   *
   * An argument list is readable by every process on the machine — `ps` shows
   * it — and this one carries the database password. It travels in the
   * environment instead.
   */
  it('passes the database URL in the environment, never in argv', () => {
    const src = stripComments(repoFile('src/lib/backup.ts'));
    expect(src).toContain('PGDATABASE: url');
    expect(src, 'الوصلة في سطر الأوامر').not.toMatch(/'--dbname',\s*url/);
    expect(src, 'الوصلة في سطر الأوامر').not.toMatch(/\$\{url\}/);
  });

  /**
   * AND THE DUMP IS READ BACK BEFORE IT COUNTS.
   *
   * `pg_dump` can exit zero and leave a truncated archive if the disk fills
   * mid-write. An unreadable archive in the folder is worse than none,
   * because it looks like one — so it is listed, and deleted if it will not.
   */
  it('lists the archive before calling it a backup, and deletes one that will not', () => {
    const src = stripComments(repoFile('src/lib/backup.ts'));
    expect(src).toMatch(/pg_restore', \['--list'/);
    expect(src).toContain('غير قابلة للقراءة');
    const check = src.slice(src.indexOf("pg_restore', ['--list'"));
    expect(check.slice(0, 400), 'لا تُحذف النسخة التالفة').toContain('unlink(file)');
  });

  /**
   * AND THE IMAGE THAT RUNS THE JOB HAS THE COMMAND.
   *
   * This is not theoretical: the runtime stage installed `libc6-compat
   * openssl` and nothing else, so `daily-backup` would have failed on the
   * first night in production with «command not found» — a backup system
   * that had never existed, reporting an error nobody reads until the day it
   * is needed. Found before shipping, and pinned here.
   */
  it('and the runtime image carries pg_dump', () => {
    // `#` comments stripped first. The comment above the line explains WHY
    // the package is there and names it — so the first version of this test
    // passed with the package deleted, which the mutation run caught. Sixth
    // time a guard in this repository has read its own prose.
    const dockerfile = repoFile('Dockerfile')
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('#'))
      .join(' ');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('ENV HOSTNAME'));
    expect(runtime, 'صورة التشغيل بلا عميل PostgreSQL').toContain('postgresql16-client');
    // Matching the server in docker-compose: an older client refuses to dump
    // a newer server.
    expect(repoFile('docker-compose.yml')).toContain('postgres:16-alpine');
  });

  /**
   * AND THE FOLDER IT WRITES TO CAN BE WRITTEN.
   *
   * The job writes `./backups` and the server runs from /app as `nextjs`.
   * /app belongs to root, so the job's `mkdir` was refused — measured on
   * 28/10 in the local container built from this file on 21/10: the app's
   * user could not create a file in /app, and there was no /app/backups. The image makes the folder and
   * gives it to that user before switching to it, as it does for uploads.
   */
  it('and the folder it writes to exists in the image, owned by the user that runs the job', () => {
    expect(repoFile('src/lib/backup.ts')).toContain("process.env.BACKUP_DIR || './backups'");
    const lines = repoFile('Dockerfile')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('#'));
    const runtime = lines.slice(lines.findIndex((l) => /^FROM\s+base\s+AS\s+runner/.test(l)));
    expect(runtime.some((l) => /^WORKDIR\s+\/app$/.test(l)), 'الخدمة ما عادت بتشتغل من /app').toBe(true);
    const switched = runtime.findIndex((l) => /^USER\s+nextjs$/.test(l));
    expect(switched, 'صورة التشغيل ما بتتحوّل لمستخدم التطبيق').toBeGreaterThan(0);
    const made = runtime.slice(0, switched).find((l) => /^RUN\s+mkdir\s+-p\b.*\s\/app\/backups(\s|$)/.test(l));
    expect(made, 'الصورة ما بتعمل مجلد النسخ الاحتياطية').toBeTruthy();
    expect(made, 'مجلد النسخ مش لمستخدم التطبيق').toMatch(/chown\s+-R\s+nextjs:nodejs\s.*\/app\/backups(\s|$)/);
  });

  /** The job is in the scheduler that already exists, not in a second timer. */
  it('runs from the scheduler, and throws rather than reporting a quiet zero', () => {
    const defs = stripComments(repoFile('src/lib/jobs/definitions.ts'));
    expect(defs).toContain("name: 'daily-backup'");
    expect(defs).toContain('dailyBackup,');
    const job = defs.slice(defs.indexOf("name: 'daily-backup'"), defs.indexOf('export const JOBS'));
    // No try/catch swallowing the failure: the runner counts failures, backs
    // off, and alerts after three. A backup job that answers «nothing to do»
    // when the disk is full is the exact problem it exists to prevent.
    expect(job, 'المهمّة تبتلع الفشل').not.toContain('catch');
  });
});
