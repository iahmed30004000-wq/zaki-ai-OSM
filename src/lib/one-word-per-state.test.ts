import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { STATE_LABEL_AR } from './order-state';
import { SHIPPING_STATUS_AR } from './shipping-workflow';

/**
 * ONE WORD PER STATE, ON EVERY SCREEN.
 *
 * `order-state.ts` learned this for the core state and wrote it down:
 * «There were three copies… the same order read «مسلَّم» on the orders
 * list and «تم التسليم» on its own detail view». The SHIPPING status
 * never learned it, and had six vocabularies — the shipping card, the
 * tracking screen, the courier-custody screen, `ui/Badge`, the status
 * route and `i18n`. Measured before this test existed, every one of the
 * twelve values had at least two spellings, and «delivered» had five:
 *
 *   مسلَّم · تم التسليم · سُلّم · مُسلَّم · تم التوصيل
 *
 * The last of those was on the DASHBOARD, whose counters read from
 * `i18n`, beside an orders list saying «مسلَّم» about the same parcels.
 *
 * Nobody chose that. Each screen chose once.
 */

const root = process.cwd();

/**
 * EVERY SOURCE FILE, ONCE.
 *
 * `sourceFiles` inside the second describe belongs to that closure, and
 * two later rules needed the same walk. A third copy of a file walker in
 * a file about not keeping copies would have been its own joke.
 */
const allFiles = (): string[] => {
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
};

describe('the two vocabularies agree where they overlap', () => {
  it('a name both axes carry has one word', () => {
    // The core state and the shipping status describe ONE parcel. A badge
    // reading «مسلَّم» above a card reading «تم التسليم» is the defect
    // whichever of the two is «right».
    for (const [name, word] of Object.entries(SHIPPING_STATUS_AR)) {
      const core = (STATE_LABEL_AR as Record<string, string>)[name];
      if (core) expect(word, `${name}: الحالةُ والشحنُ يختلفان`).toBe(core);
    }
  });

  it('and the overlap is real, not an empty coincidence', () => {
    const shared = Object.keys(SHIPPING_STATUS_AR).filter(
      (n) => n in STATE_LABEL_AR
    );
    expect(shared.length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * AND NOBODY WRITES ONE OF THOSE WORDS BY HAND.
 *
 * A second copy is how the first six happened. The owners are the two
 * maps; everything else imports them.
 */
describe('no screen keeps its own copy', () => {
  /** The files allowed to contain these words as literals. */
  const OWNERS = ['src/lib/order-state.ts', 'src/lib/shipping-workflow.ts'];

  /**
   * `i18n.ts` holds the same words for the dashboard's counters and is
   * a translation table, not a screen. It is checked by VALUE below
   * instead of being forbidden the literal.
   */
  const TRANSLATIONS = 'src/lib/i18n.ts';

  /**
   * THE COURIER'S OWN WORDS ARE NOT OURS TO TIDY.
   *
   * `logestechs.ts` carries their status table, copied from their
   * documentation and matched against what their API sends back. Their
   * «تم التوصيل» is a foreign string we recognise, not a label we write,
   * and rewriting it would break the matching.
   */
  const FOREIGN = ['src/lib/couriers/logestechs.ts'];

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

  /** The spellings that were found in the wild and are no longer allowed. */
  const RETIRED: Record<string, string> = {
    'تم التسليم': 'مسلَّم',
    'تم التوصيل': 'مسلَّم',
    'سُلّم': 'مسلَّم',
    'مُسلَّم': 'مسلَّم',
    'تم الشحن': 'مشحون',
    'خارج للتوصيل': 'خرج للتوصيل',
    'تعذر التوصيل': 'فشل التوصيل',
    'تعذّر التوصيل': 'فشل التوصيل',
    'طُلب إرجاعه': 'طلب إرجاع',
    'مطلوب إرجاعه': 'طلب إرجاع',
    'مُرتجع': 'مرتجع',
    /*
     * `SHIPPING_STATUS_AR`'s own note lists both spellings of
     * READY_FOR_PICKUP and says which won. It was never added here, so
     * `order-timeline.ts` kept the loser in a private copy of the whole
     * vocabulary — and the same parcel read «جاهز للاستلام» in the order
     * dialog's timeline and «بانتظار الاستلام» on the tracking screen.
     */
    'جاهز للاستلام': 'بانتظار الاستلام',
  };

  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (OWNERS.includes(file) || FOREIGN.includes(file)) continue;
    const src = readFileSync(join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      /*
       * AN ACTION IS NOT A STATE.
       *
       * «تم التسليم» on a BUTTON means «record that it was delivered» —
       * a verb, and the right words for one. `labelAr` is where this
       * product puts the word on a transition button, and a rule that
       * could not tell the two apart would have renamed every action in
       * the shipping card into a noun.
       */
      if (/\blabelAr\s*:/.test(lines[i])) continue;
      for (const [retired, instead] of Object.entries(RETIRED)) {
        // Only as a quoted label — the word inside a sentence a person
        // reads («تم التسليم بنجاح») is prose, not a state's name.
        if (new RegExp(`['"\`]${retired}['"\`]`).test(lines[i])) {
          offenders.push(`${file}:${i + 1}   «${retired}» — الكلمةُ المعتمدة «${instead}»`);
        }
      }
    }
  }

  it('found files to check — a sweep over nothing proves nothing', () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
  });

  it('and no retired spelling is used as a label', () => {
    expect(offenders, `تهجئةٌ متروكةٌ لحالةٍ لها كلمةٌ معتمدة:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and the dashboard counters read the canonical words', () => {
    const src = readFileSync(join(root, TRANSLATIONS), 'utf8');
    // `t.DELIVERED` and `t.SHIPPED` are what the dashboard prints.
    expect(src).toMatch(/DELIVERED: 'مسلَّم'/);
    expect(src).toMatch(/SHIPPED: 'مشحون'/);
    expect(src).toMatch(/NO_ANSWER: 'لا يرد'/);
  });
});

/**
 * AND THE CONFIRMATION AXIS, WHICH HAD FOUR VOCABULARIES.
 *
 * The shipping axis was settled and guarded; the confirmation axis was not.
 * Measured: `CONFIRMATION_STATUSES`' eight values were spelled in four
 * places and five of the eight disagreed —
 *
 *   NO_ANSWER           لا يرد (six files)  ·  لا يجيب (the order dialog)
 *   IN_PROGRESS         قيد التأكيد  ·  قيد المعالجة
 *   FOLLOW_UP_REQUIRED  يحتاج متابعة  ·  يتطلب متابعة  ·  بحاجة متابعة
 *   POSTPONED           مؤجل  ·  مؤجَّل
 *   CONFIRMED           مؤكد  ·  مؤكَّد
 *
 * So an agent read «لا يجيب» in the order dialog and «لا يرد» in the list
 * about the same order, and the server refused in a third wording again.
 *
 * `CONFIRMATION_STATUS_AR` is the owner, and six of its eight values are
 * read from `STATE_LABEL_AR` rather than retyped, because the core axis
 * names the same states — which is the rule `shipping-workflow.ts` wrote.
 *
 * WHAT THIS DOES NOT FORBID: the shadda spellings «مؤجَّل» and «مؤكَّد»
 * appear in about twenty files as ordinary prose («طلبٌ مؤكَّد»), which is
 * writing, not a label. The rule is about MAPPING a status name to a word.
 */
describe('one vocabulary for the confirmation axis', () => {
  const OWNER = 'src/lib/confirmation-workflow.ts';

  /*
   * WHICH MAP IS A CONFIRMATION VOCABULARY, AND WHICH ONLY SHARES A KEY.
   *
   * A first version flagged any map from a confirmation status name to an
   * Arabic word, and named seven files that were right: `STATE_LABEL_AR`
   * (the CORE axis's own owner, which names NEW and CONFIRMED because they
   * are core states), `i18n.ts` (the translation table the other block here
   * checks by value instead), `SETTLEMENT_AR`, `LEGACY_ONLY`, and the
   * courier's own `LOGESTECHS_STATUS_AR`. Every one of them collides on a
   * key like CANCELLED without being about confirmation at all.
   *
   * So the discriminator is not a list of exemptions to maintain: it is
   * `IN_PROGRESS` and `FOLLOW_UP_REQUIRED`, the two names NO other axis in
   * this product has. A map that spells either of them is a confirmation
   * vocabulary, and there may be only one.
   */
  const ONLY_CONFIRMATION = /\b(IN_PROGRESS|FOLLOW_UP_REQUIRED)\s*:\s*(?:\{\s*ar\s*:\s*)?['"`]([\u0600-\u06FF][^'"`]*)['"`]/g;

  const offenders: string[] = [];
  for (const file of allFiles()) {
    if (file === OWNER) continue;
    const src = readFileSync(join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const m of src.matchAll(ONLY_CONFIRMATION)) {
      offenders.push(`${file}  ${m[1]} = «${m[2]}»`);
    }
  }

  it('found files to check — a sweep over nothing proves nothing', () => {
    expect(allFiles().length).toBeGreaterThan(200);
  });

  it('and only one file spells a confirmation status', () => {
    expect(
      offenders,
      `نسخةٌ أخرى من مفردات التأكيد:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('and six of the eight are read from the core axis, not retyped', async () => {
    const { CONFIRMATION_STATUS_AR } = await import('./confirmation-workflow');
    const { STATE_LABEL_AR } = await import('./order-state');
    expect(CONFIRMATION_STATUS_AR.NO_ANSWER).toBe(STATE_LABEL_AR.NO_ANSWER);
    // The confirmation axis's name for the core axis's CLAIMED.
    expect(CONFIRMATION_STATUS_AR.IN_PROGRESS).toBe(STATE_LABEL_AR.CLAIMED);
    expect(CONFIRMATION_STATUS_AR.POSTPONED).toBe(STATE_LABEL_AR.POSTPONED);
    expect(CONFIRMATION_STATUS_AR.CONFIRMED).toBe(STATE_LABEL_AR.CONFIRMED);
    expect(CONFIRMATION_STATUS_AR.CANCELLED).toBe(STATE_LABEL_AR.CANCELLED);
    expect(CONFIRMATION_STATUS_AR.NEW).toBe(STATE_LABEL_AR.NEW);
  });

  it('and every status has a word', async () => {
    const { CONFIRMATION_STATUS_AR, CONFIRMATION_STATUSES } = await import('./confirmation-workflow');
    for (const key of CONFIRMATION_STATUSES) {
      expect(CONFIRMATION_STATUS_AR[key], key).toMatch(/[\u0600-\u06FF]/);
    }
  });
});

/**
 * AND THE PRODUCT'S OWN STATUS, WHICH HAD FIVE WORDINGS FOR THREE VALUES.
 *
 * The schema says `ACTIVE | INACTIVE | OUT_OF_STOCK`. The screens said:
 *
 *   OUT_OF_STOCK  «نفد المخزون» on the products badge
 *                 «نفد من المخزون» in that same screen's own dropdown
 *                 «نفد المخزون» in its other dropdown
 *                 «نفد من المخزن» in i18n — المخزن is the building, not the stock
 *   ACTIVE        «نشط» in the list, and the bare word `ACTIVE` on the
 *                 product's own page
 *
 * So the badge and the dropdown beside it disagreed about the state they
 * were both showing, and opening the product showed the database's word.
 *
 * THE DISCRIMINATOR IS `OUT_OF_STOCK`, for the same reason `IN_PROGRESS`
 * serves the confirmation axis: ACTIVE and INACTIVE belong to users, to
 * couriers and to channels as well, and a rule keyed on those would name
 * every one of them. Only a product runs out of stock.
 */
describe('one vocabulary for the product status', () => {
  const OWNER = 'src/lib/product-status.ts';
  /**
   * `i18n.ts` is the translation table, not a screen — the block above
   * treats it the same way. It is checked BY VALUE below instead of being
   * forbidden the literal.
   */
  const TRANSLATIONS = 'src/lib/i18n.ts';

  const offenders: string[] = [];
  for (const file of allFiles()) {
    if (file === OWNER || file === TRANSLATIONS) continue;
    const src = readFileSync(join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const m of src.matchAll(/OUT_OF_STOCK["']?\s*[:>]\s*["'>]?\s*([\u0600-\u06FF][^<'"`]*)/g)) {
      offenders.push(`${file}  OUT_OF_STOCK = «${m[1].trim()}»`);
    }
  }

  it('and only one file spells it', () => {
    expect(
      offenders,
      `نسخةٌ أخرى من مفردات حالة المنتج:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('and the translation table agrees with the owner, value for value', async () => {
    const { PRODUCT_STATUS_AR, PRODUCT_STATUSES } = await import('./product-status');
    const i18n = readFileSync(join(root, TRANSLATIONS), 'utf8');
    for (const key of PRODUCT_STATUSES) {
      expect(i18n, `${key} في i18n يخالف المالك`).toContain(`${key}: '${PRODUCT_STATUS_AR[key]}'`);
    }
  });

  it('and the stock is «المخزون», not the building it sits in', async () => {
    const { PRODUCT_STATUS_AR } = await import('./product-status');
    expect(PRODUCT_STATUS_AR.OUT_OF_STOCK).toBe('نفد المخزون');
  });

  it('and a value the schema does not name still prints something', async () => {
    const { productStatusAr } = await import('./product-status');
    expect(productStatusAr('ACTIVE')).toBe('نشط');
    // Better the raw value than an empty badge — it is a bug upstream.
    expect(productStatusAr('WHATEVER')).toBe('WHATEVER');
    expect(productStatusAr(null)).toBe('—');
  });
});

/**
 * AND THE TOP OF EVERY SCREEN, WHICH `PageHeader` SETTLED.
 *
 * Its note records what it replaced: «fifty-five titles across fifty-one
 * screens… `text-2xl` here, `text-xl` there… the actions above the title on
 * one and below it on the next». One screen was still drawing its own —
 * the product's page, at `text-2xl`, breaking to a row at `sm` where every
 * other screen breaks at `md`.
 */
describe('one shape for the top of a screen', () => {
  it('and the product page is no longer the exception', () => {
    const src = readFileSync(join(root, 'src/components/screens/ProductDetailScreen.tsx'), 'utf8');
    expect(src, 'عاد العنوانُ إلى قياسٍ خاصٍّ به').not.toMatch(/<h1[^>]*text-2xl/);
    // 19/11 (R12b): it read «the screen writes `md:flex-row md:items-start md:justify-between` itself». The page now stands on
    // `PageShell`, which draws exactly that `PageHeader` (the next test holds its shape) — so the screen no longer writes its own
    // header row at all, and that is the stronger form of «no longer the exception»: no h1 of its own either.
    expect(src).toContain('<PageShell');
    expect(src).not.toMatch(/<h1\b/);
  });

  it('and the one component still says the size and the order', () => {
    const header = readFileSync(join(root, 'src/components/ui/PageHeader.tsx'), 'utf8');
    expect(header).toMatch(/<h1 className="text-xl font-bold/);
    expect(header).toMatch(/md:flex-row md:items-start md:justify-between/);
  });
});
