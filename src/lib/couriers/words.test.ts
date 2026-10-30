import { describe, expect, it } from 'vitest';
import { LOGESTECHS_STATUS_AR } from './logestechs';
import {
  COURIER_CODES_READ,
  COURIER_OUTCOMES,
  COURIER_OUTCOME_AR,
  courierWordNote,
  isNoMoneyCell,
  normalizePhrase,
  readCourierWord,
  tallyCourierWords,
} from './words';

/**
 * THE COURIER'S WORD, READ FROM AN EXACT-PHRASE TABLE — ONE TABLE, SEEDED FROM THE COMPANY'S OWN.
 *
 * A word that is not in the table reads UNKNOWN and decides nothing. Never a piece of a word: «تم» is not a
 * delivery («تم رفضه»), «قيد» is not on the way («قيد المراجعة»).
 */

describe('every phrase the company documents is read, and read as what it means', () => {
  // The expectation is written out, per phrase, so a change to the table is a change somebody meant.
  const EXPECTED: Record<string, string> = {
    'طلبات جديدة': 'IN_TRANSIT',
    'بانتظار تعيين سائق': 'IN_TRANSIT',
    'ملغاة': 'CANCELLED',
    'بانتظار موافقة سائق': 'IN_TRANSIT',
    'رفضها السائق': 'IN_TRANSIT',
    'بانتظار التحميل': 'IN_TRANSIT',
    'بالمركبة': 'IN_TRANSIT',
    'تم التوصيل': 'DELIVERED',
    'مؤجلة': 'POSTPONED',
    'تم ارجاعها': 'RETURNED',
    'مغلقة': 'OTHER',
    'مصدرة لشريك': 'OTHER',
    'تم توصيلها بشكل جزئي': 'PARTIAL',
    'تم تبديلها': 'OTHER',
    'تم احضارها': 'OTHER',
    'مسلمة الى المرسل': 'RETURNED',
    'مصدرة الى طرف ثالث': 'OTHER',
  };

  it('all seventeen, by name', () => {
    const phrases = Object.values(LOGESTECHS_STATUS_AR);
    expect(phrases).toHaveLength(17);
    for (const phrase of phrases) {
      expect(EXPECTED[phrase], `«${phrase}» ما انكتب له قراءة هنا`).toBeDefined();
      expect(readCourierWord(phrase), phrase).toMatchObject({ outcome: EXPECTED[phrase], known: true });
    }
  });

  it('and the table is seeded from the company’s list by construction — no code is read here that it lacks, none missing', () => {
    expect([...COURIER_CODES_READ].sort()).toEqual(Object.keys(LOGESTECHS_STATUS_AR).sort());
  });

  it('every reading has a sentence for the screen', () => {
    for (const o of COURIER_OUTCOMES) expect(COURIER_OUTCOME_AR[o], o).toBeTruthy();
  });
});

describe('«مؤجل» and «مؤجلة» are one reading', () => {
  it('both read POSTPONED, however they are typed', () => {
    for (const w of ['مؤجل', 'مؤجلة', 'مؤجله', '  مؤجلة ', 'مُؤَجَّلة', 'مؤجـــلة']) {
      expect(readCourierWord(w), w).toMatchObject({ outcome: 'POSTPONED', known: true });
    }
  });

  it('and the two carry the same sentence on the screen', () => {
    expect(COURIER_OUTCOME_AR[readCourierWord('مؤجل')!.outcome]).toBe(COURIER_OUTCOME_AR[readCourierWord('مؤجلة')!.outcome]);
  });
});

describe('the words a statement FILE uses', () => {
  it('«تم توصيلها» is a delivery, «تم إرجاعها» (with a hamza) is a return, «قيد التوصيل» is on the way', () => {
    expect(readCourierWord('تم توصيلها')).toMatchObject({ outcome: 'DELIVERED' });
    expect(readCourierWord('تم إرجاعها')).toMatchObject({ outcome: 'RETURNED' });
    expect(readCourierWord('تم ارجاعها')).toMatchObject({ outcome: 'RETURNED' });
    expect(readCourierWord('قيد التوصيل')).toMatchObject({ outcome: 'IN_TRANSIT' });
  });
});

describe('anything not in the table is UNKNOWN — never a guess from a piece of the word', () => {
  it.each(['تم رفضه', 'لم يتم التسليم', 'تم', 'قيد المراجعة', 'delivered', 'مؤجلة للأسبوع القادم', 'تم التوصيل للعميل', '???'])(
    '«%s» reads UNKNOWN',
    (w) => {
      expect(readCourierWord(w)).toEqual({ phrase: w, outcome: 'UNKNOWN', known: false });
    }
  );

  it('an empty cell says no word at all (null), which is not UNKNOWN', () => {
    expect(readCourierWord('')).toBeNull();
    expect(readCourierWord('   ')).toBeNull();
    expect(readCourierWord(null)).toBeNull();
    expect(readCourierWord(undefined)).toBeNull();
  });

  it('and the phrase is kept as the courier wrote it, so the screen shows their word, not ours', () => {
    expect(readCourierWord('  تم توصيلها ')!.phrase).toBe('تم توصيلها');
    expect(readCourierWord('كلمة جديدة')!.phrase).toBe('كلمة جديدة');
  });
});

describe('the normal form folds spellings, not meanings', () => {
  it('folds hamza, final ة/ه, ى/ي, diacritics and the stretch character — and no more', () => {
    expect(normalizePhrase('إرجاعها')).toBe(normalizePhrase('ارجاعها'));
    expect(normalizePhrase('مؤجلة')).toBe(normalizePhrase('مؤجله'));
    expect(normalizePhrase('مسلّمة')).toBe(normalizePhrase('مسلمة'));
    // «مؤجل» and «مؤجلة» stay two phrases — which is why both are in the table.
    expect(normalizePhrase('مؤجل')).not.toBe(normalizePhrase('مؤجلة'));
  });
});

describe('the tally of a whole file — the import door’s reading', () => {
  it('counts what each line says and lists the unknown words once, as written', () => {
    const t = tallyCourierWords(['تم توصيلها', 'تم توصيلها', 'مؤجل', 'مؤجلة', null, '', 'كلمة غريبة', 'كلمة غريبة', 'أخرى']);
    expect(t.byOutcome).toEqual({ DELIVERED: 2, POSTPONED: 2, UNKNOWN: 3 });
    expect(t.unknown).toEqual(['كلمة غريبة', 'أخرى']);
  });

  it('lists at most twenty unknown words, so one odd file cannot flood the answer', () => {
    const many = Array.from({ length: 50 }, (_, i) => `كلمة${i}`);
    const t = tallyCourierWords(many);
    expect(t.unknown).toHaveLength(20);
    expect(t.byOutcome.UNKNOWN).toBe(50);
  });
});

describe('the sentence beside a row that needs a person', () => {
  it('quotes the company’s word', () => {
    expect(courierWordNote(readCourierWord('مؤجلة'))).toBe('قالت الشركة: «مؤجلة»');
    expect(courierWordNote(readCourierWord('مؤجل'))).toBe('قالت الشركة: «مؤجل»');
  });

  it('says plainly that it does not know a word', () => {
    expect(courierWordNote(readCourierWord('كلمة غريبة'))).toBe('كلمة الشركة «كلمة غريبة» لا نعرفها بعد');
  });

  it('says nothing for a delivery or for no word at all', () => {
    expect(courierWordNote(readCourierWord('تم توصيلها'))).toBeNull();
    expect(courierWordNote(null)).toBeNull();
  });
});

describe('a money cell that says «nothing here»', () => {
  it.each(['', '   ', '-', '--', '—', '–', '−', '_', '..', '/', 'لا يوجد', 'لايوجد', 'لا شيء', 'بدون', 'فاضي', 'N/A', 'n/a', 'NA', 'null', 'None'])(
    '«%s» is no money',
    (cell) => {
      expect(isNoMoneyCell(cell)).toBe(true);
    }
  );

  it.each(['0', '0.000', '9.0', '(50)', '-5', '-0.5', '3,500', '٣٥٠٠', '٣٥٠٠ د.أ', '12abc', 'غير معروف', 'تم'])(
    '«%s» is NOT no-money: it is a figure, or something to refuse by name',
    (cell) => {
      expect(isNoMoneyCell(cell)).toBe(false);
    }
  );
});
