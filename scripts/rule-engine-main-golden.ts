/**
 * THE GOLDEN OF REQUEST Q3b — what the engine answered on `osm/main` BEFORE it read a stored rule, over the seeded scenarios of `rule-engine-scenarios.ts`
 * (`src/lib/the-rule-engine-equals-main.test.ts` asks today's code for the same answers, with no rule and with the default rule handed in).
 *
 * Recipe (from the worktree root; the copies sit beside the modules so their relative imports resolve, and are deleted after):
 *
 *   for f in no-answer-cadence call-proof confirmation-rule-summary queue-priority; do git show <main-sha>:src/lib/$f.ts > src/lib/$f.main-copy.ts; done
 *   npx tsx scripts/rule-engine-main-golden.ts main src/lib/the-rule-engine-equals-main.golden.json [n] [seed]
 *   rm src/lib/*.main-copy.ts
 *
 * `main` reads the four copies; `today` reads the modules as they are (a local larger run compares the two files byte for byte).
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runScenarios } from './rule-engine-scenarios';

export const GOLDEN_N = 200;
export const GOLDEN_SEED = 20261119;

async function main() {
  const [which, out, n, seed] = process.argv.slice(2);
  const suffix = which === 'main' ? '.main-copy.ts' : '.ts';
  const load = (name: string) => import(pathToFileURL(resolve(`src/lib/${name}${suffix}`)).href);
  const [cadence, proof, summary, priority] = await Promise.all([load('no-answer-cadence'), load('call-proof'), load('confirmation-rule-summary'), load('queue-priority')]);
  const result = runScenarios({ cadence, proof, summary, priority }, { n: Number(n ?? GOLDEN_N), seed: Number(seed ?? GOLDEN_SEED) });
  const rows = (xs: unknown[]) => xs.map((x) => '  ' + JSON.stringify(x)).join(',\n');
  const body = Object.entries(result)
    .map(([k, v]) => `"${k}":[\n${rows(v as unknown[])}\n]`)
    .join(',\n');
  writeFileSync(out, `{${body}}\n`);
  console.log(Object.entries(result).map(([k, v]) => `${k} ${(v as unknown[]).length}`).join(' · '));
  process.exit(0);
}

void main();
