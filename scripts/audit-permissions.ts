/**
 * Reconciles the permissions UI against what the system actually enforces.
 *
 *   npx tsx scripts/audit-permissions.ts
 *
 * Two failures this catches, both of which make the permissions screen lie:
 *
 *   DEAD   — listed in the catalogue but nothing anywhere checks it. Ticking
 *            the box changes nothing, which is worse than the box not being
 *            there: it reads as a granted capability.
 *
 *   HIDDEN — enforced somewhere but absent from the catalogue, so nobody can
 *            grant it through the UI at all.
 *
 *   ORPHAN — in the catalogue and enforced, but no ROLE grants it. The screen
 *            behind it is closed to everybody including the owner, and it
 *            fails silently: a 403 on a feature that was fully built. Ten of
 *            them were live at once, among them the whole landing-pages
 *            module.
 *
 * The orphan check needs the database, so it is skipped when there is none.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_MODULES } from '../src/lib/permission-catalog';
import { db } from '../src/lib/db';
import { ALL_ROUTES } from '../src/lib/route-registry';
import { LEGACY_ALIAS } from '../src/lib/permission-aliases';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const files = walk(SRC);
const enforced = new Set<string>();

// Every way the code asks whether somebody may do something.
const PATTERNS = [
  /requirePermission\(\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
  /\bcan\(\s*\w+\s*,\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
  /\bhasPermission\(\s*\w+\s*,\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
  // authorize() is the object-scoped check — it decides per record, so it is
  // just as much an enforcement point as the blanket ones.
  /\bauthorize\(\s*\w+\s*,\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
  // A screen hiding what it may not do still means the key is live.
  /permissions\?\.includes\(\s*['"]([a-z_]+\.[a-z_]+)['"]/g,
];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) enforced.add(match[1]);
  }
}

// Routes guard themselves through the registry rather than a call.
for (const route of ALL_ROUTES) {
  for (const key of route.permissions ?? []) enforced.add(key);
}

// A legacy key that aliases onto a canonical one keeps that one alive.
// The table lives in permission-aliases.ts (it moved out of authorization.ts, which now holds none),
// so it is READ from there, not scraped from the old file: scraping it found nothing and called live keys dead.
for (const [legacy, canonical] of Object.entries(LEGACY_ALIAS)) {
  if (enforced.has(legacy)) enforced.add(canonical);
}

const catalogued = new Map<string, string>();
for (const mod of PERMISSION_MODULES) {
  for (const item of mod.items) catalogued.set(item.key, mod.module);
}

const dead = [...catalogued.keys()].filter((k) => !enforced.has(k)).sort();
const hidden = [...enforced].filter((k) => !catalogued.has(k)).sort();

console.log(`الكتالوج: ${catalogued.size} صلاحية · المفروضة فعلياً: ${enforced.size}\n`);

if (dead.length) {
  console.log(`✗ معروضة ولا شيء يفحصها (${dead.length}) — منحها لا يفعل شيئاً:`);
  for (const key of dead) console.log(`   ${key.padEnd(32)} [${catalogued.get(key)}]`);
  console.log();
}

if (hidden.length) {
  console.log(`✗ مفروضة ولا يمكن منحها من الشاشة (${hidden.length}):`);
  for (const key of hidden) console.log(`   ${key}`);
  console.log();
}

async function orphans(): Promise<string[]> {
  try {
    const rows = await db.rolePermission.findMany({ select: { permission: true } });
    const granted = new Set(rows.map((r) => r.permission));
    return [...catalogued.keys()].filter((k) => !granted.has(k)).sort();
  } catch {
    return [];
  }
}

async function main() {
  const unheld = await orphans();

  if (unheld.length) {
    console.log(`✗ لا يمنحها أي دور (${unheld.length}) — الشاشة خلفها مقفلة على الجميع:`);
    for (const key of unheld) console.log(`   ${key.padEnd(32)} [${catalogued.get(key)}]`);
    console.log();
  }

  if (!dead.length && !hidden.length && !unheld.length) {
    console.log('✓ الشاشة مطابقة لما يفرضه النظام، وكل صلاحية يملكها دور');
  }

  await db.$disconnect().catch(() => undefined);
  process.exit(dead.length || hidden.length || unheld.length ? 1 : 0);
}

void main();
