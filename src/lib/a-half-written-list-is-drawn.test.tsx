// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { newSection, landingSectionSchema, type LandingSection } from './landing-sections';
import { structureToSections } from './landing-structure';
import { applyCopyToSections, sameArrangement } from './landing-copy-apply';
import { LANDING_STRUCTURES, STRUCTURE_QUIZ, STRUCTURE_TRANSFORMATION } from './landing-structures';
import { PageBlocks, type BlockContext } from '@/components/landing/blocks/PageBlocks';

/**
 * A SHORT PROPOSAL MUST NOT BREAK THE PREVIEW.
 *
 * A slot may address one cell of a list (`questions.1.ask`), and the row is
 * created when it is written to — as `{ ask: "…" }`, every other column
 * missing. The block schema has a default for each missing column and the
 * renderers lean on them (`q.options.filter(…)`), so a page built from a
 * proposal that filled only «السؤال الثاني» threw inside the creation
 * preview, and the editor's «طبّق على أقسامي» did the same on a page it had
 * just been handed.
 *
 * Checked over EVERY slot of EVERY shipped structure, one at a time — the
 * shortest proposal there can be — not over the two that were reported.
 */

afterEach(cleanup);

const ctx: BlockContext = {
  palette: {} as BlockContext['palette'],
  productName: 'كريم',
  price: 10,
  currency: 'SYP',
  stock: null,
  offers: [],
  form: <div>FORM</div>,
};

const draw = (sections: LandingSection[]) => render(<PageBlocks sections={sections} ctx={ctx} />);
const copyOf = (key: string) => ({ [key]: { msa: 'نص تجريبي' } });

describe('building a page from one slot of copy', () => {
  for (const structure of LANDING_STRUCTURES) {
    it(`«${structure.id}»: each slot alone draws, and every block is a whole block`, () => {
      for (const slot of structure.slots) {
        const sections = structureToSections(structure, copyOf(slot.key), 'msa', newSection);
        for (const s of sections) {
          expect(landingSectionSchema.safeParse(s).success, `${slot.key} → ${s.type}`).toBe(true);
        }
        expect(() => draw(sections), slot.key).not.toThrow();
        cleanup();
      }
    });
  }

  it('the second question alone: the quiz is drawn and keeps no hole', () => {
    const sections = structureToSections(STRUCTURE_QUIZ, copyOf('q2'), 'msa', newSection);
    const quiz = sections.find((s) => s.type === 'quiz');
    expect(quiz && quiz.type === 'quiz' && quiz.questions[1].ask).toBe('نص تجريبي');
    expect(quiz && quiz.type === 'quiz' && quiz.questions[1].options).toEqual([]);
    expect(() => draw(sections)).not.toThrow();
  });
});

describe('fitting one slot of copy into a page that exists', () => {
  const blank = (structure: (typeof LANDING_STRUCTURES)[number]) =>
    structure.sequence.map((t) => newSection(t));

  for (const structure of LANDING_STRUCTURES) {
    it(`«${structure.id}»: each slot alone draws, and the arrangement is untouched`, () => {
      for (const slot of structure.slots) {
        const before = blank(structure);
        const { sections, placed } = applyCopyToSections({
          sections: before, structure, copy: copyOf(slot.key), dialect: 'msa',
        });
        expect(placed.length, slot.key).toBeGreaterThan(0);
        expect(sameArrangement(before, sections), slot.key).toBe(true);
        for (const s of sections) {
          expect(landingSectionSchema.safeParse(s).success, `${slot.key} → ${s.type}`).toBe(true);
        }
        expect(() => draw(sections), slot.key).not.toThrow();
        cleanup();
      }
    });
  }

  it('the middle answer alone in a timeline: no throw, the row is whole', () => {
    const before = STRUCTURE_TRANSFORMATION.sequence.map((t) => newSection(t));
    const { sections } = applyCopyToSections({
      sections: before, structure: STRUCTURE_TRANSFORMATION, copy: copyOf('stage2What'), dialect: 'msa',
    });
    const t = sections.find((s) => s.type === 'timeline');
    expect(t && t.type === 'timeline' && t.points[1]).toEqual({ when: '', what: 'نص تجريبي' });
  });
});

describe('what is already whole is left exactly as it was', () => {
  it('a row the seller filled in keeps every character, and the blocks they did not touch are the same objects', () => {
    const before = STRUCTURE_QUIZ.sequence.map((t) => newSection(t));
    const quiz = before.find((s) => s.type === 'quiz')!;
    if (quiz.type === 'quiz') quiz.questions = [{ ask: 'سؤالي', options: ['أ', 'ب'] }];

    const { sections } = applyCopyToSections({
      sections: before, structure: STRUCTURE_QUIZ, copy: copyOf('q2'), dialect: 'msa',
    });

    const after = sections.find((s) => s.type === 'quiz')!;
    expect(after.type === 'quiz' && after.questions[0]).toEqual({ ask: 'سؤالي', options: ['أ', 'ب'] });
    // the blocks no slot wrote into are not even re-created
    const hero = before.findIndex((s) => s.type === 'hero');
    expect(sections[hero]).toEqual(before[hero]);
  });

  it('copy longer than the field allows is still cut, not lost', () => {
    const long = 'ك'.repeat(500);
    const sections = structureToSections(STRUCTURE_QUIZ, { q1: { msa: long } }, 'msa', newSection);
    const quiz = sections.find((s) => s.type === 'quiz');
    const ask = quiz && quiz.type === 'quiz' ? quiz.questions[0].ask : '';
    expect(ask.length).toBeGreaterThan(0);
    expect(ask.length).toBeLessThanOrEqual(120);
  });
});
