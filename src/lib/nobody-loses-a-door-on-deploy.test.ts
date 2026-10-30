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
 * 20261029150000_settings_split_keys does not write each key's name next to its INSERT: it takes one gate table
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
  const sql = readFileSync(path.join(MIGRATIONS, '20261029150000_settings_split_keys', 'migration.sql'), 'utf8')
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

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HELPERS' BOX (PR-5) — ai.assist, GRANTED THROUGH A SNAPSHOT TOO.
 *
 * 20261030120000_ai_assist_key reads one source table (`sp5_src`), not a key next to each INSERT, so the first block of this
 * file cannot see it either. Here: the five sources are exactly the keys the five helpers asked before, the box lands in
 * both tables, and it is written to run twice. The full replay is `the-assistants-box-keeps-every-door.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('ai.assist', () => {
  const sql = readFileSync(path.join(MIGRATIONS, '20261030120000_ai_assist_key', 'migration.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('is in the catalog, so the owner can tick it', () => {
    expect(ALL_CATALOG_KEYS.has('ai.assist')).toBe(true);
  });

  it('is granted FROM each key one of the five helpers asked before', () => {
    for (const source of ['confirmation.work', 'ops.prepare', 'landing_pages.edit', 'orders.create', 'orders.view']) {
      expect(sql, `ai.assist مش مأخوذ من ${source} — من يمرّ بالمساعد رح يخسره`).toContain(`('${source}')`);
    }
  });

  it('lands in BOTH tables, carries the «منع» across, and runs twice without changing anything', () => {
    expect(sql).toContain('INSERT INTO "role_permission_defaults"');
    expect(sql).toContain('INSERT INTO "role_permissions"');
    expect(sql).toContain(`'DENY'`);
    for (const s of sql.split(/;\s*\n/).filter((x) => x.trim().startsWith('INSERT INTO'))) {
      expect(s).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER ACTIONS' BOXES (PR-6) — GRANTED THROUGH A GATE TABLE TOO.
 *
 * 20261030130000_order_action_keys reads one gate table (`sp6_gate`: the box, the key the door asked, whether the scope
 * is copied), so the first block of this file cannot see it either. Here: each of the seven boxes is in the catalog, is
 * granted FROM the key (or keys) its door used to ask, lands in all three places and runs twice. The full replay —
 * every person against every door, the scope of the price, the fuzz — is `the-order-actions-keep-every-door.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the order actions’ boxes', () => {
  const sql = readFileSync(path.join(MIGRATIONS, '20261030130000_order_action_keys', 'migration.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const FROM: Record<string, string[]> = {
    'orders.change_price': ['orders.edit'],
    'orders.change_fee': ['orders.change_status'],
    'orders.cancel': ['orders.unlock'],
    'orders.note': ['orders.view', 'confirmation.work'],
    'orders.request_change': ['orders.view', 'confirmation.work'],
    'orders.rating_link': ['orders.view'],
    'control.blacklist_manage': ['control.blacklist'],
  };

  it('are all in the catalog, so the owner can tick them', () => {
    for (const k of Object.keys(FROM)) expect(ALL_CATALOG_KEYS.has(k), `${k} مش بقائمة الصلاحيات`).toBe(true);
  });

  it('are each granted FROM the key their door used to ask — a gate row per (box, key)', () => {
    for (const [box, sources] of Object.entries(FROM)) {
      for (const source of sources) {
        expect(sql.split(/\s+/).join(''),`${box} مش مأخوذ من ${source} — من يمرّ بالباب رح يخسره`).toContain(`('${box}','${source}',`);
      }
    }
  });

  it('land in all three places, carry the «منع» across, and run twice without changing anything', () => {
    expect(sql).toContain('INSERT INTO "role_permission_defaults"');
    expect(sql).toContain('INSERT INTO "role_permissions"');
    expect(sql).toContain('INSERT INTO "user_permissions"');
    expect(sql).toContain(`'DENY'`);
    for (const s of sql.split(/;\s*\n/).filter((x) => x.trim().startsWith('INSERT INTO'))) {
      expect(s).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CONFIRMATION AND CHANGE-REQUEST BOXES (PR-7) — GRANTED THROUGH A GATE TABLE, BY KEY AND BY NAME.
 *
 * 20261030140000_confirmation_split_keys reads one gate table (`sp7_gate`), like the previous two, but a row may name a ROLE
 * instead of a key — the desk’s four role names and WAREHOUSE were doors that read a NAME. Here: each new key is in the
 * catalog, is granted FROM the key (or name) its door used to ask, lands in all three places and runs twice. The full replay —
 * every person against every door, the scope, the fuzz, the one deliberate gain — is `the-confirmation-split-keeps-every-door.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the confirmation and change-request boxes', () => {
  const sql = readFileSync(path.join(MIGRATIONS, '20261030140000_confirmation_split_keys', 'migration.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const flat = sql.split(/\s+/).join('');
  const BY_KEY: Record<string, string[]> = {
    'confirmation.winback': ['confirmation.supervise'],
    'confirmation.reassign': ['confirmation.supervise'],
    'confirmation.issues_correct': ['confirmation.issues'],
    'confirmation.raise_issue': ['confirmation.issues'],
    'control.change_requests_view': ['control.change_requests'],
    'ops.decide_changes': ['ops.ship'],
    'customers.view_basic': ['customers.view'],
  };
  const BY_NAME: Record<string, string[]> = {
    'control.change_requests_view': ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'CONFIRMATION_SUPERVISOR'],
    'ops.decide_changes': ['WAREHOUSE'],
    'confirmation.raise_issue': ['CONFIRMATION_AGENT'],
  };

  it('are all in the catalog, so the owner can tick them', () => {
    for (const k of Object.keys(BY_KEY)) expect(ALL_CATALOG_KEYS.has(k), `${k} مش بقائمة الصلاحيات`).toBe(true);
  });

  it('are each granted FROM the key their door used to ask — a gate row per (box, key)', () => {
    for (const [box, sources] of Object.entries(BY_KEY)) {
      for (const source of sources) {
        expect(flat, `${box} مش مأخوذ من ${source} — من يمرّ بالباب رح يخسره`).toContain(`('${box}','${source}',NULL::text,`);
      }
    }
  });

  it('and, where the old door read a NAME, from that name too — a gate row per (box, role)', () => {
    for (const [box, names] of Object.entries(BY_NAME)) {
      for (const name of names) {
        expect(flat, `${box} مش مأخوذ من الاسم ${name} — من يمرّ بالاسم رح يخسره`).toContain(`('${box}',NULL::text,'${name}',`);
      }
    }
  });

  it('the price key is also given to whoever could decide a request without orders.edit, and to nobody who holds the edit', () => {
    for (const source of ['control.change_requests', 'ops.ship', 'confirmation.pull', 'confirmation.work', 'orders.claim']) {
      expect(flat).toContain(`('orders.change_price','${source}',NULL::text,false,'orders.edit')`);
    }
    expect(flat).toContain(`('orders.change_price',NULL::text,'WAREHOUSE',false,'orders.edit')`);
  });

  it('land in all three places, carry the «منع» across, and run twice without changing anything', () => {
    expect(sql).toContain('INSERT INTO "role_permission_defaults"');
    expect(sql).toContain('INSERT INTO "role_permissions"');
    expect(sql).toContain('INSERT INTO "user_permissions"');
    expect(sql).toContain(`'DENY'`);
    for (const s of sql.split(/;\s*\n/).filter((x) => x.trim().startsWith('INSERT INTO'))) {
      expect(s).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OPERATIONS BOXES (PR-8) — GRANTED THROUGH A GATE TABLE: ONE ROW PER (BOX, KEY THE DOOR ASKED).
 *
 * 20261030160000_ops_action_keys reads one gate table (`sp8_gate`), like the finance one. Here: each new key is in the
 * catalog, is granted FROM the key (or keys) its door used to ask, lands in all three places and runs twice. The full replay —
 * every person against every door, the untouched stand-down door and cancel box, the fuzz — is `the-ops-split-keeps-every-door.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('the operations boxes', () => {
  const sql = readFileSync(path.join(MIGRATIONS, '20261030160000_ops_action_keys', 'migration.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const flat = sql.split(/\s+/).join('');
  const BY_KEY: Record<string, string[]> = {
    'ops.batches': ['ops.ship', 'ops.track'],
    'ops.deliver': ['ops.track'],
    'ops.transfer': ['ops.track'],
    'ops.write_off': ['finance.update', 'orders.unlock'],
    'ops.return_fee': ['ops.returns'],
  };

  it('are all in the catalog, so the owner can tick them', () => {
    for (const k of Object.keys(BY_KEY)) expect(ALL_CATALOG_KEYS.has(k), `${k} مش بقائمة الصلاحيات`).toBe(true);
  });

  it('are each granted FROM the key their door used to ask — a gate row per (box, key)', () => {
    for (const [box, sources] of Object.entries(BY_KEY)) {
      for (const source of sources) {
        expect(flat, `${box} مش مأخوذ من ${source} — من يمرّ بالباب رح يخسره`).toContain(`('${box}','${source}')`);
      }
    }
  });

  it('land in all three places, carry the «منع» across, and run twice without changing anything', () => {
    expect(sql).toContain('INSERT INTO "role_permission_defaults"');
    expect(sql).toContain('INSERT INTO "role_permissions"');
    expect(sql).toContain('INSERT INTO "user_permissions"');
    expect(sql).toContain(`'DENY'`);
    for (const s of sql.split(/;\s*\n/).filter((x) => x.trim().startsWith('INSERT INTO'))) {
      expect(s).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
    }
  });
});
