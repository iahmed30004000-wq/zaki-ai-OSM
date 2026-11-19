import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q3b — THE DIFFERENTIAL: «NOTHING STORED = osm/main, BYTE FOR BYTE»
 *
 * `the-rule-engine-equals-main.golden.json` was written by `scripts/rule-engine-main-golden.ts` from the four modules as they were on `osm/main` BEFORE the engine read a
 * stored rule (8e830b0b) — `no-answer-cadence.ts`, `call-proof.ts`, `confirmation-rule-summary.ts`, `queue-priority.ts` — over the seeded scenarios of
 * `scripts/rule-engine-scenarios.ts` (n = 200, seed 20261119): door-written histories pressed one by one (counted · due · closes · days · the words after the press · the
 * desk · the card · the timeline's numbers · the fold), lines the door never wrote (any stored due, garbage, any order), single steps past the limit, the call proof
 * (verdict · state · paired line), «القاعدة بالمختصر» over every switch combination and four windows, and «fresh».
 *
 * Today's code answers them TWICE — with nothing handed in (a hand-built calendar, a caller with no rule), and with the DEFAULT rule handed in exactly as the doors hand
 * the rule in force (`cadenceCalOf(…, rule)`, `proofSeconds`, `limit`, `freshMinutes`, `RuleFacts.rule`). Both must be the golden, record for record.
 * (Before the PR the same comparison ran locally over 20 000 scenarios per table, main against today: the two files were identical.)
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('./db', () => ({ db: {} }));

import * as cadence from './no-answer-cadence';
import * as proof from './call-proof';
import * as summary from './confirmation-rule-summary';
import * as priority from './queue-priority';
import { CONFIRMATION_RULE_DEFAULT } from './confirmation-rule-settings';
import { runScenarios } from '../../scripts/rule-engine-scenarios';

const golden = JSON.parse(readFileSync(join(process.cwd(), 'src/lib/the-rule-engine-equals-main.golden.json'), 'utf8')) as Record<string, unknown[]>;
const N = 200;
const SEED = 20261119;
const mods = { cadence, proof, summary, priority };

describe('the golden is the one the recipe writes', () => {
  it('six tables, n = 200 each where seeded, and 128 summaries (16 switch states × 4 windows × 2 hand/idle pairs)', () => {
    expect(Object.keys(golden)).toEqual(['histories', 'folds', 'steps', 'proofs', 'summaries', 'fresh']);
    for (const k of ['histories', 'folds', 'steps', 'proofs']) expect(golden[k]).toHaveLength(N);
    expect(golden.summaries).toHaveLength(128);
    expect(golden.fresh).toHaveLength(50);
  });
});

describe.each([
  ['nothing handed in', undefined],
  ['the default rule handed in, as the doors hand the rule in force', CONFIRMATION_RULE_DEFAULT],
] as const)('%s → osm/main, record for record', (_name, rule) => {
  const today = JSON.parse(JSON.stringify(runScenarios(mods, { n: N, seed: SEED, rule }))) as Record<string, unknown[]>;
  it.each(['histories', 'folds', 'steps', 'proofs', 'summaries', 'fresh'])('%s', (table) => {
    for (let i = 0; i < golden[table].length; i++) expect(today[table][i], `${table}[${i}]`).toEqual(golden[table][i]);
    expect(today[table]).toHaveLength(golden[table].length);
  });
});
