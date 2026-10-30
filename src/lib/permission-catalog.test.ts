import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_MODULES } from './permission-catalog';
import { ALL_ROUTES } from './route-registry';

/**
 * The permissions screen must not lie.
 *
 * Two ways it can, and both are worse than an incomplete screen:
 *
 *   A permission listed that nothing checks reads as a granted capability.
 *   An admin ticks it, believes access was given, and it was not.
 *
 *   A permission enforced but not listed cannot be granted at all, so the
 *   only way to get past it is a role that happens to include it.
 *
 * This drifted badly once: the CRM module was deleted in Stage 2 and 108 of
 * its permissions were still being granted across four roles months later.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every key the code actually gates something on. */
function enforcedKeys(): Set<string> {
  const enforced = new Set<string>();

  const patterns = [
    /requirePermission\(\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
    /\bcan\(\s*\w+\s*,\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
    /\bhasPermission\(\s*\w+\s*,\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
    /\bauthorize\(\s*\w+\s*,\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
    /permissions\?\.includes\(\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
  ];

  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) enforced.add(match[1]);
    }
  }

  // A route guards itself through the registry rather than a call.
  for (const route of ALL_ROUTES) {
    for (const key of route.permissions ?? []) enforced.add(key);
  }

  // A legacy key aliasing onto a canonical one keeps that one alive.
  // The table moved to permission-aliases.ts (shared with the browser's userCan); read it where it lives.
  const auth = readFileSync(join(SRC, 'lib', 'permission-aliases.ts'), 'utf8');
  for (const match of auth.matchAll(/['"]([a-z_]+\.[a-z_]+)['"]\s*:\s*['"]([a-z_]+\.[a-z_]+)['"]/g)) {
    if (enforced.has(match[1])) enforced.add(match[2]);
  }

  return enforced;
}

const catalogued = new Map<string, string>();
for (const mod of PERMISSION_MODULES) {
  for (const item of mod.items) catalogued.set(item.key, mod.module);
}

describe('the permissions screen matches what the system enforces', () => {
  const enforced = enforcedKeys();

  it('lists nothing that nothing checks', () => {
    const dead = [...catalogued.keys()].filter((k) => !enforced.has(k)).sort();
    expect(dead, `معروضة ولا شيء يفحصها: ${dead.join(', ')}`).toEqual([]);
  });

  it('lists everything that is enforced', () => {
    const hidden = [...enforced].filter((k) => !catalogued.has(k)).sort();
    expect(hidden, `مفروضة ولا يمكن منحها: ${hidden.join(', ')}`).toEqual([]);
  });

  it('carries no CRM permission — that module is gone', () => {
    expect([...catalogued.keys()].filter((k) => k.startsWith('crm.'))).toEqual([]);
  });

  it('promises no delete the system refuses to perform', () => {
    // An order is VOIDED: its history has to outlive it, so the delete this key promised never existed.
    // PR-13 (قديم ← جديد): `users.delete` left this list. The profile's PATCH has always had a `delete` action (the owner's, API-only,
    // never on a SUPER_ADMIN or on oneself), and it rode on «تعديل المستخدمين»; the key now names that act so the owner can untick it
    // from whoever edits profiles. The key is asked by `can(admin, 'users.delete')` in that route, so it is enforced, not promised.
    for (const key of ['orders.delete']) {
      expect(catalogued.has(key), key).toBe(false);
    }
  });
});

describe('the catalogue itself is well formed', () => {
  it('has no duplicate key across modules', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const mod of PERMISSION_MODULES) {
      for (const item of mod.items) {
        if (seen.has(item.key)) dupes.push(item.key);
        seen.add(item.key);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('labels every key in both languages', () => {
    for (const mod of PERMISSION_MODULES) {
      for (const item of mod.items) {
        expect(item.ar.trim(), item.key).not.toBe('');
        expect(item.en.trim(), item.key).not.toBe('');
      }
    }
  });

  it('has no empty module', () => {
    for (const mod of PERMISSION_MODULES) {
      expect(mod.items.length, mod.module).toBeGreaterThan(0);
    }
  });
});
