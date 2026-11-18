import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CORE_STATES, STATE_TONE, type CoreState } from './order-state';

/**
 * «THE SAME STATE SHOWS THE SAME WORD AND THE SAME COLOUR ON EVERY SCREEN.»
 *
 * The word half has owners and a guard. The colour half had an owner —
 * `STATE_TONE`, with its reasons written beside it — and no guard, so a
 * screen could disagree with it and nothing said so.
 *
 * Measured on the dashboard's seven status tiles: three of them did.
 * NEW, CONTACTING and SHIPPED were painted `--sys-primary` while the owner
 * calls all three `neutral`, and `order-state.ts` rules that out by name:
 *
 *   «There is no informational blue — the action colour is already in the
 *    blue family, and a chip painted the same family as a button is a chip
 *    people try to press.»
 *
 * So «مشحون» read in the accent on the dashboard and in plain foreground on
 * the orders list: two different claims about the same parcel, three clicks
 * apart.
 */

const root = process.cwd();

const OWNERS = [
  'src/lib/order-state.ts',
  'src/lib/shipping-workflow.ts',
  'src/components/ui/StatusChip.tsx',
  'src/components/ui/Badge.tsx',
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, 'src'));
  return out;
}

const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('the accent colour never carries a state', () => {
  /*
   * WHY THE ACCENT AND NOT ALL FOUR.
   *
   * A rule that read «a state name and any semantic colour on one line»
   * flagged twenty-eight lines, and most were right: a shipping BATCH's
   * own states, a profit LINE's states, a Telegram MESSAGE's states, and
   * the transition BUTTONS whose colour belongs to the action — a
   * distinction `one-word-per-state` already had to make in words.
   *
   * The accent is different. `STATE_TONE` has no tone that maps to it, by a
   * decision written out in `order-state.ts`, so a core state's name beside
   * `--sys-primary` is wrong whatever else is on the line. That is a rule
   * with no exceptions to keep, which is why it is the one being guarded.
   */
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (OWNERS.includes(file)) continue;
    const src = code(readFileSync(join(root, file), 'utf8'));
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/--sys-primary/.test(line)) continue;
      // `t.NEW` / `STATE.SHIPPED` / `'DELIVERED'` — the core axis's names.
      const named = CORE_STATES.filter((s) => new RegExp(`\\b${s}\\b`).test(line));
      if (named.length === 0) continue;
      offenders.push(`${file}:${i + 1}  ${named.join(',')}  ${line.trim().replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }

  it('found files to check — a sweep over nothing proves nothing', () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
  });

  it('and no screen paints a state with the action colour', () => {
    expect(
      offenders,
      `حالةٌ مرسومةٌ بلون الفعل — وSTATE_TONE لا يملك هذه النغمة:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});

describe('and the owner is what screens read', () => {
  it('gives every core state exactly one tone', () => {
    for (const s of CORE_STATES) {
      expect(STATE_TONE[s as CoreState], s).toMatch(/^(neutral|good|warn|bad)$/);
    }
  });

  it('and the dashboard tiles take theirs from it', () => {
    // 18/11 (R9): the tiles moved from the dashboard to the performance board. Was: DashboardScreen.tsx.
    const src = readFileSync(join(root, 'src/components/screens/PerformanceScreen.tsx'), 'utf8');
    // The tile builder, and no hand-picked colour beside a state name.
    expect(src).toMatch(/const tone = STATE_TONE\[state\]/);
    expect(src).toMatch(/color: TONE_TEXT\[tone\], dot: TONE_DOT\[tone\]/);
  });

  it('and the tone parts live in one place, agreeing with the chip', async () => {
    const { TONE_TEXT, TONE_DOT } = await import('@/components/ui/StatusChip');
    for (const tone of ['neutral', 'good', 'warn', 'bad'] as const) {
      expect(TONE_TEXT[tone], tone).toMatch(/^text-\[var\(--sys-[a-z-]+\)\]$/);
      expect(TONE_DOT[tone], tone).toMatch(/^bg-\[var\(--sys-[a-z-]+\)\]$/);
      // And none of them is the action colour.
      expect(TONE_TEXT[tone], tone).not.toContain('--sys-primary');
      expect(TONE_DOT[tone], tone).not.toContain('--sys-primary');
    }
  });
});
