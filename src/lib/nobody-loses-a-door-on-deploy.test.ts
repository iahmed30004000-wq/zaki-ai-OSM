import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ALL_CATALOG_KEYS } from './permission-catalog';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A NEW PERMISSION TAKES A DOOR AWAY UNTIL SOMETHING GRANTS IT.
 *
 * The day `orders.import` ships, every role that could import yesterday
 * holds `orders.create` and not `orders.import` — so unless a migration
 * grants it, the deploy silently removes a door from everybody and the
 * owner finds out from an employee. The same for `orders.contact_log`,
 * which would leave every confirmation agent unable to record a call, and
 * for `orders.navigate`.
 *
 * ⚠️ WHAT THIS TEST IS, SAID PLAINLY: it reads SQL. There is no database
 * in CI, so it cannot run the migration and look at the rows — it checks
 * that each new key is granted FROM the permission its door used to ask
 * for, which is the thing that is easy to get wrong by hand.
 * 🔧 The migration was also applied to a real local database and the
 * resulting role lists compared against the source permissions; that
 * measurement is in the pull request, and it is the stronger evidence.
 * ═══════════════════════════════════════════════════════════════════════
 */

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');

/** Every migration's SQL, as one string. A grant may live in any of them. */
function allMigrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((d) => !d.endsWith('.toml'))
    .map((d) => {
      try {
        return readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

/**
 * The three this task added, and the permission each one's door used to
 * ask for. Getting this mapping wrong is the whole risk: grant from the
 * wrong source and a role either loses a door or gains one nobody meant.
 */
const GRANTED_FROM: Record<string, string[]> = {
  'orders.import': ['orders.create'],
  'orders.contact_log': ['orders.edit', 'orders.claim', 'orders.confirm'],
  'orders.navigate': ['orders.view'],
};

describe('the three new order permissions', () => {
  const sql = allMigrationSql();

  it('are all in the catalog, so the owner can actually tick them', () => {
    for (const key of Object.keys(GRANTED_FROM)) {
      expect(ALL_CATALOG_KEYS.has(key), `${key} مش بقائمة الصلاحيات`).toBe(true);
    }
  });

  it('are each granted by a migration, not left for the owner to notice', () => {
    for (const key of Object.keys(GRANTED_FROM)) {
      expect(sql, `${key} ما في ترحيل بيمنحه — الأدوار رح تخسر الباب`).toContain(`'${key}'`);
    }
  });

  it('and each is granted FROM the permission its door used to ask for', () => {
    for (const [key, sources] of Object.entries(GRANTED_FROM)) {
      // The INSERT that mentions this key, up to its terminating semicolon.
      const statements = sql
        .split(';')
        .filter((s) => s.includes(`'${key}'`) && s.includes('INSERT INTO'));
      expect(statements.length, `${key}: ما في عبارة إدخال`).toBeGreaterThan(0);

      for (const source of sources) {
        expect(
          statements.some((s) => s.includes(`'${source}'`)),
          `${key} مش مأخوذ من ${source} — دور بيحمل ${source} رح يخسر الباب`
        ).toBe(true);
      }
    }
  });

  it('and lands in BOTH tables, so «إرجاع للافتراضي» does not undo the migration', () => {
    /*
     * `role_permission_defaults` is what the «إرجاع للافتراضي» button
     * reads. Without rows there, pressing it on any role would quietly
     * strip the three new permissions back off — a button that undoes a
     * migration is a bug that looks like a feature.
     */
    for (const key of Object.keys(GRANTED_FROM)) {
      const toDefaults = sql
        .split(';')
        .some((s) => s.includes('role_permission_defaults') && s.includes(`'${key}'`));
      expect(toDefaults, `${key} مش بجدول الافتراضيّات — زرّ «إرجاع للافتراضي» رح يشيله`).toBe(true);
    }
  });

  it('and is written so running it twice changes nothing', () => {
    for (const key of Object.keys(GRANTED_FROM)) {
      const statements = sql.split(';').filter((s) => s.includes(`'${key}'`) && s.includes('INSERT INTO'));
      for (const s of statements) {
        expect(s, `${key}: إدخال بلا ON CONFLICT — إعادة التشغيل بتفشل`).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
      }
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE TEN SETTINGS BOXES (PR-4) — THE SAME RULE, FOR KEYS GRANTED THROUGH A SNAPSHOT.
 *
 * 20261029140000_settings_split_keys does not write each key's name next to its INSERT: it takes one gate table
 * («this box ← that key») and every INSERT reads it. So the checks above, which look for a statement naming both the
 * key and its source, cannot see it. The checks below read the gate table itself — and the full replay of the people
 * it touches is in `the-settings-split-keeps-every-door.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the ten settings boxes', () => {
  const GATES: Record<string, string[]> = {
    'settings.jobs': ['settings.manage'],
    'settings.messages': ['settings.manage'],
    'penalties.rules': ['settings.manage'],
    'team.settings': ['settings.manage'],
    'offers.rules': ['settings.manage'],
    'commission.view': ['settings.view'],
    'commission.manage': ['settings.edit'],
    'settings.delivery_fees': ['settings.edit'],
    'settings.tracking': ['settings.edit'],
    'orders.migrate': ['orders.import', 'settings.manage'],
  };
  const sql = readFileSync(path.join(MIGRATIONS, '20261029140000_settings_split_keys', 'migration.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('are all in the catalog, so the owner can tick them', () => {
    for (const key of Object.keys(GATES)) expect(ALL_CATALOG_KEYS.has(key), `${key} مش بقائمة الصلاحيات`).toBe(true);
  });

  it('are each granted FROM the key their door used to ask for — a gate row, or the migration box’s two halves', () => {
    for (const [key, sources] of Object.entries(GATES)) {
      if (key === 'orders.migrate') {
        for (const s of sources) expect(sql, `${key} مش مأخوذ من ${s}`).toContain(`'${s}'`);
        expect(sql).toContain(`'orders.migrate'::text`);
        continue;
      }
      // The gate table aligns its columns with spaces; read it with them collapsed.
      expect(sql.replace(/\s+/g, ' '), `${key} ما في صف بالجدول من ${sources[0]} — الأدوار رح تخسر الباب`).toContain(`('${key}', '${sources[0]}')`);
    }
  });

  it('land in BOTH tables, so «إرجاع للافتراضي» does not undo the migration — and carry the «منع» across', () => {
    expect(sql).toContain('INSERT INTO "role_permission_defaults"');
    expect(sql).toContain('INSERT INTO "role_permissions"');
    expect(sql).toContain(`'DENY'`);
  });

  it('and are written so running them twice changes nothing', () => {
    for (const s of sql.split(/;\s*\n/).filter((x) => x.trim().startsWith('INSERT INTO'))) {
      expect(s, 'إدخال بلا ON CONFLICT — إعادة التشغيل بتفشل').toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
    }
  });
});
