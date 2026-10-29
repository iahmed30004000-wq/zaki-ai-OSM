import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_MODULES } from './permission-catalog';
import { stripComments } from './guard-source';

/**
 * A PERMISSION'S LABEL IS WHAT SOMEBODY GRANTS BY.
 *
 * Nobody assigning a role reads the routes. They read one line on a screen,
 * tick it, and move on — so the label is not documentation, it is the
 * interface to the decision. A label that names less than the key gates is
 * not a cosmetic problem; it is a person handing over something they did not
 * know they were handing over.
 *
 * Found on 2026-10-02: `settings.manage` was labelled «تشغيل المهام
 * المجدولة» / «Run scheduled jobs». It gates ELEVEN routes, and the other
 * ten include the courier's API credentials (read and test), the ad accounts,
 * and the AI provider settings. A manager granting what the screen called
 * "run scheduled jobs" was granting the company's keys.
 *
 * These guards cannot read intent, so they check the two things a machine
 * CAN: that the catalog is complete and consistent, and that the one label
 * that lied names its keys for as long as it gates them.
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((p) => ({
  // `split(sep).join('/')` because Node hands back backslashes on Windows,
  // and a path filter written with forward slashes then matches nothing —
  // silently, which is how a sweep passes while guarding air.
  rel: relative(SRC, p).split(sep).join('/'),
  text: stripComments(readFileSync(p, 'utf8')),
}));

/** Every permission key the code actually enforces, with where. */
const ENFORCED = new Map<string, string[]>();
for (const { rel, text } of FILES) {
  for (const m of text.matchAll(/(?:requirePermission|can)\(\s*(?:user,\s*)?'([a-z_]+\.[a-z_]+)'/g)) {
    const at = ENFORCED.get(m[1]) ?? [];
    at.push(rel);
    ENFORCED.set(m[1], at);
  }
}

const DECLARED = new Set(PERMISSION_MODULES.flatMap((g) => g.items.map((i) => i.key)));

describe('the catalog is the whole list, in both directions', () => {
  it('every permission the code enforces can be granted on the screen', () => {
    /*
     * A key enforced but not declared is a door nobody can be given. The
     * comment beside `settings.manage` records exactly that happening once:
     * «Enforced on /api/admin/jobs but was missing here, so nobody could be
     * granted it through the screen.»
     */
    const missing = [...ENFORCED.keys()].filter((k) => !DECLARED.has(k)).sort();
    expect(missing, `صلاحيات يفرضها الكود ولا تظهر في الشاشة:\n${missing.join('\n')}`).toEqual([]);
  });

  it('and every label is written in both languages, with no placeholder', () => {
    for (const group of PERMISSION_MODULES) {
      for (const item of group.items) {
        expect(item.ar.trim().length, `${item.key}: بلا نصّ عربي`).toBeGreaterThan(3);
        expect(item.en.trim().length, `${item.key}: no English`).toBeGreaterThan(3);
        // A label that repeats the key teaches nobody anything.
        expect(item.ar, item.key).not.toContain(item.key);
      }
    }
  });

  it('and no two keys are declared twice', () => {
    const keys = PERMISSION_MODULES.flatMap((g) => g.items.map((i) => i.key));
    expect(keys.length, 'مفتاح مُعلَن مرّتين').toBe(new Set(keys).size);
  });
});

describe('`settings.manage` names what it actually opens', () => {
  const label = PERMISSION_MODULES.flatMap((g) => g.items).find((i) => i.key === 'settings.manage');

  it('gates the credentials — the measurement that started this — and no longer the jobs it was named after', () => {
    const where = (ENFORCED.get('settings.manage') ?? []).sort();
    // PR-4: the jobs route has a box of its own (settings.jobs), so this label must not claim it any more…
    expect(where.some((f) => f.includes('admin/jobs'))).toBe(false);
    expect((ENFORCED.get('settings.jobs') ?? []).some((f) => f.includes('admin/jobs'))).toBe(true);
    // …and the three that are credentials stay.
    expect(where.some((f) => f.includes('delivery-providers') && f.includes('credentials'))).toBe(true);
    expect(where.some((f) => f.includes('settings/ad-accounts'))).toBe(true);
    expect(where.some((f) => f.includes('settings/ai'))).toBe(true);
    // It is the breadth that makes the label matter.
    expect(where.length).toBeGreaterThanOrEqual(8);
  });

  it('so the label says keys, not only jobs', () => {
    expect(label).toBeDefined();
    expect(label!.ar).toMatch(/مفاتيح/);
    expect(label!.en.toLowerCase()).toMatch(/credential/);
    // And the old wording must not come back on its own.
    expect(label!.ar).not.toBe('تشغيل المهام المجدولة');
    expect(label!.en).not.toBe('Run scheduled jobs');
  });

  it('and no longer mentions the jobs — that door is behind settings.jobs now, whose label does', () => {
    // A label that names a door it no longer gates is the same defect as one that hides a door it does.
    expect(label!.ar).not.toMatch(/المهام المجدولة/);
    expect(label!.en.toLowerCase()).not.toMatch(/job/);
    const jobs = PERMISSION_MODULES.flatMap((g) => g.items).find((i) => i.key === 'settings.jobs');
    expect(jobs!.ar).toMatch(/المهام المجدولة/);
    expect(jobs!.en.toLowerCase()).toMatch(/job/);
  });
});
