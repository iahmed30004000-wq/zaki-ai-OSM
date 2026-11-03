import { describe, expect, it } from 'vitest';
import { TONES, TONE_LABEL, landingCopyBrief, notesRefusal } from './landing-copy-brief';
import { LANDING_STRUCTURES } from './landing-structures';
import { buildPageBrief } from './landing-build';

/**
 * «الأسلوب» AND «الملاحظات» — ONE SENTENCE EACH, AND THE RULES DO NOT MOVE.
 *
 * The wizard's AI path asks how the page should sound (ودود · عرض مقنع ·
 * فاخر · خبير وواقعي) and, optionally, what to stress. Both reach the
 * brief. Neither may change what the model is allowed to claim: the screen
 * prints «الذكاء الاصطناعي ما بيخترع تقييمات ولا خصومات ولا أرقام», and
 * that is only true while the rules are in every brief, whatever the voice.
 */

const STRUCTURE = LANDING_STRUCTURES[0];
const PRODUCT = { name: 'كريم الظهر', description: 'كريم مرطّب', price: 12, currency: 'JOD' };
const base = { structure: STRUCTURE, dialect: 'levantine' as const, product: PRODUCT };

describe('the voice', () => {
  it('has the four Arabic names the wizard shows', () => {
    expect(TONES.map((t) => TONE_LABEL[t])).toEqual(['ودود', 'عرض مقنع', 'فاخر', 'خبير وواقعي']);
  });

  it('adds exactly one line to the brief', () => {
    const without = landingCopyBrief(base).split('\n');
    for (const tone of TONES) {
      const withTone = landingCopyBrief({ ...base, tone }).split('\n');
      expect(withTone.length).toBe(without.length + 1);
      expect(withTone.find((l) => l.startsWith('الأسلوب:'))).toBeTruthy();
    }
  });

  it('leaves the no-invention rule in place for every voice, «عرض مقنع» above all', () => {
    for (const tone of TONES) {
      expect(landingCopyBrief({ ...base, tone })).toContain('لا تخترع رقماً');
    }
  });

  it('is absent when none was chosen — the brief is the one it always was', () => {
    expect(landingCopyBrief(base)).not.toContain('الأسلوب:');
  });
});

describe('the notes', () => {
  it('reach the brief, under the rules and not instead of them', () => {
    const brief = landingCopyBrief({ ...base, notes: 'ركّز إنه بيدوم سنة' });
    expect(brief).toContain('ركّز إنه بيدوم سنة');
    expect(brief.indexOf('ركّز إنه بيدوم سنة')).toBeLessThan(brief.indexOf('## القواعد'));
    expect(brief).toContain('لا تخترع رقماً');
  });

  it('leave no heading behind when empty', () => {
    expect(landingCopyBrief({ ...base, notes: '   ' })).not.toContain('ملاحظات البائع');
  });

  it('are allowed when they speak of the product', () => {
    expect(notesRefusal('ركّز على 150 مل و3 قطع')).toBeNull();
    expect(notesRefusal('')).toBeNull();
    expect(notesRefusal(undefined)).toBeNull();
  });

  it('are refused when they carry a phone number, in either digits', () => {
    expect(notesRefusal('اتصل على 0799 123 456')).toMatch(/رقم/);
    expect(notesRefusal('الرقم ٠٧٩٩١٢٣٤٥٦')).toMatch(/رقم/);
    expect(notesRefusal('0799-123-456')).toMatch(/رقم/);
  });

  it('are refused whatever stands between the digits, and in Persian digits too', () => {
    // The three that walked round the first version of this rule.
    expect(notesRefusal('اتصل 07 99  12 34 56')).toMatch(/رقم/);
    expect(notesRefusal('0799/123/456')).toMatch(/رقم/);
    expect(notesRefusal('رقمه ۰۷۹۹۱۲۳۴۵۶')).toMatch(/رقم/);
    // And digits scattered through words still add up.
    expect(notesRefusal('07 الزبون 99 بيحكي 123 بكرا 456')).toMatch(/رقم/);
  });

  it('are let through at six digits, the line below the rule', () => {
    expect(notesRefusal('١٢ قطعة و 3456 علبة')).toBeNull();
  });

  it('are refused when too long', () => {
    expect(notesRefusal('ا'.repeat(301))).toMatch(/أطول/);
  });
});

describe('«ابنيلي صفحة الهبوط» hears the same voice', () => {
  const specs = { name: 'كريم', nameLatin: null, description: null, category: null, attributes: {} };

  it('as one more line, with its own rules kept', () => {
    const without = buildPageBrief({ specs, hasImage: false }).split('\n');
    const withTone = buildPageBrief({ specs, hasImage: false, tone: 'offer' }).split('\n');
    expect(withTone.length).toBe(without.length + 1);
    expect(withTone.join('\n')).toContain('لا رقم من عندك');
  });

  it('and none when the wizard sent none', () => {
    expect(buildPageBrief({ specs, hasImage: false })).not.toContain('الأسلوب:');
  });
});
