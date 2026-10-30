import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ONE MAPPING FROM AN APPROVED EDIT TO THE ENGINE'S DRAFT LINE (RV471).
 *
 * The decider's preview used to carry a copy of `draftLineOf`, kept equal to the apply door's by a parity test. Now it
 * imports the door's own function, so the two cannot drift: this holds that nobody writes a second one.
 */

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('draftLineOf', () => {
  it('is defined once, in the apply door, and exported', () => {
    expect(read('src/lib/order-line-apply.ts')).toMatch(/export function draftLineOf\(/);
  });

  it('is imported by the preview, which keeps no copy of its own', () => {
    const facts = read('src/lib/change-request-review-facts.ts');
    expect(facts).not.toMatch(/function draftLineOf/);
    expect(facts).toMatch(/import \{[^}]*\bdraftLineOf\b[^}]*\} from '\.\/order-line-apply'/);
  });

  it('nothing else in the tree defines one', () => {
    const files = ['src/lib/order-line-edit.ts', 'src/lib/order-edit-facts.ts', 'src/lib/change-request-apply.ts', 'src/lib/change-request-review.ts'];
    for (const f of files) expect(read(f), f).not.toMatch(/function draftLineOf/);
  });
});
