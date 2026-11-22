import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MOVEMENT_REFERENCE_AR, UNKNOWN_REFERENCE_AR, movementReferenceAr } from './movement-reference';

/**
 * EVERY KIND OF REFERENCE A WRITER STORES HAS AN ARABIC NAME (review 22/11).
 *
 * The eye panel printed «MANUAL_COLLECTION» and «PAYSLIP» as they are stored: English on an Arabic screen. So the writers are
 * read — every `referenceType: '…'` in the shipped code — and each one must have its name; one nobody named is «مرجع آخر».
 */

const root = process.cwd();
const written = new Set<string>();
const files = (readdirSync(join(root, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !f.includes('node_modules')).map((f) => join(root, 'src', f));
for (const file of files) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/referenceType:\s*'([A-Z_]+)'/g)) written.add(m[1]);
}

describe('the «المرجع» line', () => {
  it('found the writers — a sweep over nothing proves nothing', () => {
    for (const known of ['STATEMENT', 'TRANSFER', 'EXPENSE', 'MANUAL_COLLECTION', 'PAYSLIP']) expect(written).toContain(known);
  });

  it.each([...written].sort())('%s has an Arabic name', (type) => {
    expect(MOVEMENT_REFERENCE_AR[type], type).toMatch(/[؀-ۿ]/);
    expect(movementReferenceAr(type)).not.toMatch(/[A-Z_]{3,}/);
  });

  it('NEGATIVE: a type nobody named is said in Arabic, never as its English code', () => {
    expect(movementReferenceAr('SOMETHING_NEW')).toBe(UNKNOWN_REFERENCE_AR);
    expect(UNKNOWN_REFERENCE_AR).toMatch(/^[؀-ۿ\s]+$/);
  });
});
