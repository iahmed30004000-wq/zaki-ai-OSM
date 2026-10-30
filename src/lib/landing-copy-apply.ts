import type { LandingSection, SectionType } from './landing-sections';
import { copyIn, fillMissingFields, type Dialect, type LandingStructure } from './landing-structure';

/**
 * A PROPOSAL LANDING ON A PAGE SOMEBODY ALREADY ARRANGED.
 *
 * `structureToSections` builds a page FROM a structure: it makes one section
 * per entry in `sequence`, in that order, and fills the slots. That is right
 * for a page being created and wrong for a page that exists — it would throw
 * away the blocks the seller added, the ones they deleted, the order they
 * dragged them into and every look they set, and hand them back a different
 * page wearing their words.
 *
 * So the proposal reaching the EDITOR goes the other way round: the page is
 * fixed and the copy is fitted into it. The owner's rule for this work, in
 * his words — «a look never changes the ARRANGEMENT of anything a person
 * arranged» — and words are not even a look. Nothing here adds a section,
 * removes one, moves one, enables or disables one, or touches `look`.
 *
 * WHAT IT CANNOT PLACE, IT SAYS. A structure built around a comparison table
 * has a slot for the table's first row; a page with no comparison block has
 * nowhere to put it. Silently dropping that line is how a seller comes to
 * believe the model answered badly. It is returned in `unplaced`, named by
 * the slot's own label, and the panel prints it.
 */

/** One piece of copy that found a home, for the «ما تغيّر» list. */
export interface CopyPlacement {
  slotKey: string;
  slotLabel: string;
  /** The section it was written into — the seller's own block, by id. */
  sectionId: string;
  sectionType: SectionType;
  /** `headline`, or `points.0.when`. */
  field: string;
  text: string;
}

/** One the page had no block for. */
export interface CopyUnplaced {
  slotKey: string;
  slotLabel: string;
  /** The block type the structure wanted — in the library's own vocabulary. */
  wanted: SectionType;
  /** Why: the page has no block of that type, or it has too few of them. */
  reason: 'no-such-block' | 'no-such-field';
}

export interface CopyApplyResult {
  sections: LandingSection[];
  placed: CopyPlacement[];
  unplaced: CopyUnplaced[];
  /** True when not one slot could be written — the caller must not «apply». */
  empty: boolean;
}

/**
 * WHICH OF THE PAGE'S BLOCKS A SLOT MEANS.
 *
 * A slot says `at` — an index into the structure's own `sequence` — and that
 * index means nothing on a page the seller has since rearranged. What does
 * carry over is the TYPE and the ORDER: «the second `text` block of the
 * story» is still the second `text` block on the page, wherever the seller
 * dragged it to. So the pairing is by type, in page order, nth-of-type to
 * nth-of-type.
 *
 * Matching by index instead was tried first and is worse in the one case
 * that matters: a seller who adds an announcement bar at the top shifts
 * every index by one, so the hero's headline would be written into the
 * announcement and the page would read as nonsense — the exact failure this
 * whole function exists to avoid.
 */
function nthOfType(sections: LandingSection[], type: SectionType, n: number): LandingSection | null {
  let seen = 0;
  for (const s of sections) {
    if (s.type !== type) continue;
    if (seen === n) return s;
    seen += 1;
  }
  return null;
}

export function applyCopyToSections(opts: {
  sections: LandingSection[];
  structure: LandingStructure;
  /** slot key → dialect → text, exactly as the editor and the API hold it. */
  copy: Record<string, Record<string, string> | undefined>;
  dialect: Dialect;
  /** When given, only these slot keys are written. The seller's tick boxes. */
  only?: readonly string[];
}): CopyApplyResult {
  const { sections, structure, copy, dialect } = opts;
  const only = opts.only ? new Set(opts.only) : null;

  /*
   * A COPY, SO A REFUSED PROPOSAL CHANGES NOTHING.
   *
   * `structuredClone` and not a spread: a slot may address `points.0.when`,
   * and a shallow copy would write that row into the array the caller is
   * still rendering from — so the page would change under the seller before
   * they pressed «طبّق», and pressing «إلغاء» would not take it back.
   */
  const next = structuredClone(sections) as LandingSection[];

  const placed: CopyPlacement[] = [];
  const unplaced: CopyUnplaced[] = [];

  /**
   * How many times each type has already been claimed, so two slots naming
   * two different `text` blocks reach two different paragraphs.
   *
   * Keyed by `at` and not by type: several slots share one `at` (a hero's
   * headline and its subheading are two slots on one block), and counting
   * those as two blocks would send the subheading to the next hero — of
   * which a page has none.
   */
  const seatOf = new Map<number, number>();
  const usedSeats = new Set<string>();
  for (const at of [...new Set(structure.slots.map((s) => s.at))].sort((a, b) => a - b)) {
    const type = structure.sequence[at];
    if (!type) continue;
    const before = [...usedSeats].filter((k) => k.startsWith(`${type}:`)).length;
    seatOf.set(at, before);
    usedSeats.add(`${type}:${before}`);
  }

  for (const slot of structure.slots) {
    if (only && !only.has(slot.key)) continue;
    const text = copyIn(copy[slot.key], dialect);
    if (!text) continue;

    const wanted = structure.sequence[slot.at];
    if (!wanted) continue;
    const target = nthOfType(next, wanted, seatOf.get(slot.at) ?? 0);
    if (!target) {
      unplaced.push({ slotKey: slot.key, slotLabel: slot.label, wanted, reason: 'no-such-block' });
      continue;
    }

    // Cut to the limit the slot was written under, exactly as
    // `structureToSections` does — one rule, not two. Cut and never
    // dropped: half a sentence is a bug somebody notices.
    const cut = [...text].slice(0, slot.max).join('');

    const [key, index, column] = slot.field.split('.');
    const bag = target as unknown as Record<string, unknown>;

    /*
     * THE FIELD HAS TO BE ONE THIS BLOCK HAS.
     *
     * On a page built from the structure this is always true, because the
     * contract checks every slot's field against the block its `at` points
     * at. Here the block is the SELLER's, and a mismatch is possible the
     * day a structure's sequence changes under a page that was built from
     * the old one. Writing `headline` onto a block with no headline would
     * add a key the schema refuses on save — a failure at the end of the
     * work instead of a note at the start of it.
     */
    if (!(key in bag)) {
      unplaced.push({ slotKey: slot.key, slotLabel: slot.label, wanted, reason: 'no-such-field' });
      continue;
    }

    if (index === undefined) {
      bag[key] = cut;
    } else {
      const rows = Array.isArray(bag[key]) ? (bag[key] as Record<string, unknown>[]) : [];
      const at = Number(index);
      // The row is created when it is written to, and the ones before it
      // with it: a hole in the middle of a drawn table is worse than a
      // shorter table. Same rule as the builder's own.
      while (rows.length <= at) rows.push({});
      rows[at] = { ...rows[at], [column]: cut };
      bag[key] = rows;
    }

    placed.push({
      slotKey: slot.key,
      slotLabel: slot.label,
      sectionId: target.id,
      sectionType: target.type,
      field: slot.field,
      text: cut,
    });
  }

  // A row written one cell at a time is made whole, in the same blocks that
  // were written to and no others (see fillMissingFields). The id, type and
  // enabled flag survive a parse, so `sameArrangement` still holds.
  const written = new Set(placed.map((p) => p.sectionId));
  const whole = next.map((s) => (written.has(s.id) ? fillMissingFields(s) : s));

  return { sections: whole, placed, unplaced, empty: placed.length === 0 };
}

/**
 * THE ONE CLAIM THIS MODULE MAKES, CHECKABLE FROM OUTSIDE.
 *
 * The test beside this file asserts it, and the panel asserts it again
 * before it hands the page over: an apply that changed the arrangement is
 * refused rather than shown, because by the time a seller notices their
 * blocks have moved the undo stack is the only thing standing between them
 * and an evening's work.
 */
export function sameArrangement(before: readonly LandingSection[], after: readonly LandingSection[]): boolean {
  if (before.length !== after.length) return false;
  return before.every(
    (b, i) => after[i].id === b.id && after[i].type === b.type && after[i].enabled === b.enabled
  );
}
