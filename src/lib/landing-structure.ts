import { z } from 'zod';
import { SECTION_LABEL, landingSectionSchema, type LandingSection, type SectionType } from './landing-sections';

/**
 * A PERSUASION STRUCTURE — the half of a landing page that is not its look.
 *
 * «القالب هون مش مظهر — هو بنية إقناع: ترتيب الأقسام والقصة الي بتنقل
 * الزائر من الإعلان للطلب.»
 *
 *   صفحة الهبوط = بنية (من هنا) × مظهر (من قوالب المتجر العشرة)
 *
 * The two are independent on purpose, and the contract enforces it from
 * this side: THERE IS NO COLOUR, NO FONT AND NO SHAPE ANYWHERE IN THIS
 * FILE. A structure that carried an accent would make «any structure with
 * any skin» a promise the data could break, and the first seller to try
 * the combination it broke on would be the one who found out.
 *
 * WHAT THIS IS NOT, AND THE ONE IT NEARLY DUPLICATES.
 *
 * `page-templates.ts` holds fifteen page shapes with a `bricks` list, and
 * an ordered list of sections is exactly what a structure is. It is not
 * this, for a reason that matters: each of those carries a `theme` and a
 * `swatch` — a look — so it is a structure and a skin welded together,
 * which is the thing the architecture rule above forbids. It also knows
 * nothing about the ad that sent the visitor, how warm they are, how long
 * the page should be, what each piece of copy is FOR, or how many
 * characters it may run to.
 *
 * The sequence is typed as `SectionType`, so a structure can only order
 * sections the library already draws. There is no second list of blocks
 * here and there must never be one.
 */

/**
 * THE AD THAT SENT THEM.
 *
 * «الزائر الي شاف إعلان بإطار معيّن بينزل على صفحة بتكمّل نفس القصة
 * بنفس الوعد ونفس الكلمات الأولى — مش صفحة عامة.» The framework is the
 * join between the two, so it is a closed list rather than free text: a
 * typo would silently break message match and look like nothing.
 *
 * `src/lib/ads/` is NOT this — those are the platform adapters (Meta,
 * TikTok, Snapchat) that spend the money. This is what the creative says.
 */
export const AD_FRAMEWORKS = [
  'problemSolution',
  'usVsThem',
  'ugc',
  'theHack',
  'mechanism',
  'transformation',
  'offerFirst',
  'quiz',
  'origin',
  'objections',
] as const;
export type AdFramework = (typeof AD_FRAMEWORKS)[number];

/**
 * HOW WARM THE VISITOR IS.
 *
 * A cold visitor has never heard of the product and needs the problem
 * named before anything is sold; a hot one came from an offer ad and
 * wants the price. `hesitant` is not a temperature on the usual scale and
 * is here because the brief names it: somebody who knows the product,
 * wants it, and is waiting to be told why the doubt they already have is
 * wrong.
 */
export const VISITOR_TEMPERATURES = ['cold', 'warm', 'hot', 'hesitant'] as const;
export type VisitorTemperature = (typeof VISITOR_TEMPERATURES)[number];

/** How much page a visitor is asked to read before the order. */
export const STRUCTURE_LENGTHS = ['short', 'medium', 'long'] as const;
export type StructureLength = (typeof STRUCTURE_LENGTHS)[number];

/**
 * THE FOUR WAYS THIS SYSTEM WRITES ARABIC.
 *
 * «خانات النص بتقبل نسخة لكل لهجة: شامية · مصرية · حسانية · فصحى
 * مبسطة». A page written for Damascus does not read right in Nouakchott,
 * and a seller running the same product in four markets needs four copies
 * of one slot — not four pages.
 *
 * `msa` is the fallback every slot must carry: a dialect left unwritten
 * falls back to it, so a market with no copy yet still has a page.
 */
export const DIALECTS = ['levantine', 'egyptian', 'hassaniya', 'msa'] as const;
export type Dialect = (typeof DIALECTS)[number];

/**
 * The four, in the words a seller reads.
 *
 * Beside the list rather than in whichever screen draws the chips: the
 * create dialog and the page editor both offer them, and two label maps is
 * how one of them ends up naming a dialect something the other does not.
 */
export const DIALECT_LABEL: Readonly<Record<Dialect, string>> = Object.freeze({
  levantine: 'شامية',
  egyptian: 'مصرية',
  hassaniya: 'حسانية',
  msa: 'فصحى مبسّطة',
});

/**
 * WHAT MAY BE OFFERED AS PROOF, AND WHAT SERVES IT.
 *
 * The same discipline the shop templates use for their features: a kind of
 * proof that no engine can produce is refused BY THE SCHEMA, so a
 * structure cannot promise a number nobody can compute. «ولا خانة بتقبل
 * رقم كادعاء — الأرقام من محرّك الحقائق.»
 *
 * `null` means «named, and nothing serves it yet». The brief's context
 * lists verified ratings and a repeat-purchase rate among the things that
 * already exist; they do not — there is no review model in the schema at
 * all, and `store-facts.ts` can prove delivered counts and what is bought
 * together and nothing else. They are declared here so the gap is written
 * down in the place a structure would reach for them, and refused until
 * something fills it.
 */
export const PROOF_ENGINE: Readonly<Record<string, { module: string; export: string } | null>> =
  Object.freeze({
    /** Orders actually delivered, above the sample floor. */
    deliveredCount: { module: 'store-facts', export: 'bestSellers' },
    /** What people who bought this also bought — delivered orders only. */
    boughtTogether: { module: 'store-facts', export: 'boughtTogether' },
    /** A struck-through price that happened, not one somebody typed. */
    evidencedWas: { module: 'price-honesty', export: 'evidencedWasPrices' },
    /** Ratings from verified orders. NOTHING SERVES THIS — see above. */
    verifiedRating: null,
    /** How many customers ordered again. NOTHING SERVES THIS. */
    repeatRate: null,
  });

export const PROOF_KINDS = Object.keys(PROOF_ENGINE) as string[];
export const PROOF_SERVED = PROOF_KINDS.filter((k) => PROOF_ENGINE[k]);

/**
 * A PIECE OF COPY THE SELLER WRITES, AND WHAT IT IS FOR.
 *
 * The purpose is not decoration: it is the thing that makes a writing
 * guide possible and the thing that stops a slot being filled with
 * whatever fits. «عنوان البطل ٤٠ حرف — يكرر خطّاف الإعلان» is a purpose;
 * «العنوان» is a label.
 *
 * `max` is counted in CHARACTERS, not words. Arabic words run long and a
 * word limit would let a headline overflow a 360px phone, which is the
 * screen every one of these pages is read on.
 */
export const textSlotSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-zA-Z0-9]{1,29}$/, 'المعرّف حروف لاتينية ويبدأ بحرف صغير'),
    label: z.string().trim().min(2).max(40),
    /**
     * WHAT THIS SENTENCE HAS TO DO — and the two halves beside it.
     *
     * «دليل كتابة لكل خانة: شو بتقول، وشو ممنوع تقول، ومثال بالشامي.»
     * All three live on the slot rather than in a document, because a
     * guide kept somewhere else is a guide that falls behind the slot it
     * describes — and a seller writing the headline is not reading a
     * document, they are looking at the field.
     *
     * `avoid` is required, not optional. Every one of these slots has a
     * way of going wrong that is more likely than the others — an invented
     * number, a medical claim, a competitor's name — and naming it is the
     * whole value of a guide. A slot with nothing to avoid has not been
     * thought about.
     *
     * `example` is Levantine because that is what the brief asks for and
     * because an example in formal Arabic teaches the wrong register:
     * these pages are read by somebody who came from a TikTok ad.
     */
    purpose: z.string().trim().min(10).max(160),
    avoid: z.string().trim().min(10).max(160),
    example: z.string().trim().min(3).max(600),
    max: z.number().int().min(8).max(600),
    /**
     * WHERE THIS COPY LANDS.
     *
     * A structure that lists its sections and its slots separately knows
     * what a page is made of and not what goes where — so nothing could
     * turn one into a page. «المشكلة ← الحل» has three prose beats in a
     * row, and they are not interchangeable: which paragraph is «المحاولات
     * الفاشلة» is the structure, not a detail.
     *
     * `at` is the index in `sequence`; `field` is the name the section's
     * own schema gives that piece of text — `headline` on a hero, `body`
     * on a text block, `text` on an urgency bar. Both are checked below
     * against the sequence they point into.
     *
     * AND `field` MAY NAME A ROW AND A COLUMN: `points.0.when`.
     *
     * Five of the ten structures are built around a block whose content is a
     * LIST — the comparison's rows, the timeline's points, the quiz's
     * questions, the objections and their answers, the mechanism's steps. A
     * slot that could only address one named field could not reach any of
     * them, so those blocks were created empty, an empty block draws nothing,
     * and «رحلة التحوّل» came out as a page with no timeline in it: the one
     * thing that makes it that structure.
     *
     * The fix is not a new kind of slot. A slot is one piece of text with its
     * own purpose, its own «ممنوع» and its own example, and that is exactly
     * what a cell of those tables is — «الأسبوع الأول» wants a different
     * example from «الأسبوع الثامن». So the ADDRESS grew a row and a column
     * and everything else stayed: the same schema, the same editor, the same
     * library block, untouched.
     *
     * The row index is explicit rather than a count, so a structure says how
     * many rows it wants by writing that many slots — and the duplicate-seat
     * check below then does its ordinary job on them.
     */
    at: z.number().int().min(0).max(13),
    field: z
      .string()
      .trim()
      .regex(
        /^[a-z][a-zA-Z0-9]{1,23}(\.\d{1,2}\.[a-z][a-zA-Z0-9]{1,23})?$/,
        'الحقل اسمٌ، أو اسمُ قائمةٍ ورقمُ صفٍّ واسمُ عمود مثل points.0.when'
      ),
    /** A page cannot be published with this one empty. */
    required: z.boolean().default(true),
    /**
     * NO SLOT MAY HOLD A FIGURE PRESENTED AS A FACT.
     *
     * «ولا خانة بتقبل رقم كادعاء». A seller typing «٥٠٠٠ عميل سعيد» into
     * a headline is a claim this system cannot stand behind, and it is the
     * single easiest lie to write. Numbers reach a page through
     * `PROOF_ENGINE` or not at all.
     *
     * This flag says the slot is ALLOWED to contain digits — a size, a
     * dose, a model number — and it is off by default, so the permissive
     * case is the one somebody has to ask for.
     */
    mayContainDigits: z.boolean().default(false),
  })
  .strict();

export type TextSlot = z.infer<typeof textSlotSchema>;

/**
 * The copy for one slot, in as many dialects as have been written.
 *
 * PARTIAL, AND THAT IS THE WHOLE POINT: «ما لا تكتبه بلهجة يظهر بالفصحى
 * المبسّطة». `z.record(z.enum(…), …)` is EXHAUSTIVE in zod 4 — it demanded
 * all four dialects and would have refused every real copy map, which is
 * exactly the case this schema exists for.
 */
export const slotCopySchema = z.partialRecord(
  z.enum(DIALECTS),
  z.string()
);

/**
 * WHERE THE ORDER BUTTON COMES BACK.
 *
 * «إيقاع الأزرار: زر طلب بعد كل كم قسم». A long page with one button at
 * the bottom asks a visitor who is already convinced to keep scrolling,
 * and a page with a button after every paragraph reads as a shop that is
 * shouting. The rhythm is a number because that is what it is.
 */
export const ctaRhythmSchema = z
  .object({
    /** An order button after every N sections. 0 = only where the sequence puts one. */
    everyNSections: z.number().int().min(0).max(6),
    /**
     * «زر طلب ثابت بأسفل الجوال بكل بنية» — not a per-structure choice.
     * It is in the schema as a literal so a structure cannot turn it off.
     */
    stickyOnMobile: z.literal(true),
  })
  .strict();

/**
 * THE FIRST SCREEN, AND THE FOUR THINGS THAT MUST BE ON IT.
 *
 * «أربع عناصر ظاهرة بلا تمرير على جوال 360 بكسل بكل بنية وكل مظهر:
 * السعر مع العرض · زر الطلب · سطر الدفع عند الاستلام · عنصر ثقة مربوط
 * بحقائق حقيقية.»
 *
 * Each is a literal `true`, which is the point: a structure declares its
 * first screen and the only declaration the schema accepts is the one
 * that carries all four. There is no «hide the price above the fold»
 * because there is no value for it.
 */
export const firstScreenSchema = z
  .object({
    priceWithOffer: z.literal(true),
    orderButton: z.literal(true),
    codLine: z.literal(true),
    /** Which proof stands on the first screen. It must be one something serves. */
    trust: z.string().refine((k) => PROOF_ENGINE[k] != null, {
      message: 'دليلٌ لا يخدمه محرّك الحقائق',
    }),
  })
  .strict();

/**
 * A structure's footer carries the legal pages and nothing else.
 *
 * «ما في قائمة تنقّل ولا روابط خروج — هدف واحد بالصفحة», and «تذييل بسيط
 * فيه الصفحات القانونية فقط — ضرورية لقبول الإعلانات». Both halves matter:
 * the exit links are what lose the order, and the three legal pages are
 * what Meta and TikTok require before they will run the ad at all.
 */
export const LEGAL_PAGES = ['privacy', 'terms', 'returns'] as const;

export const landingStructureSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z][a-z0-9-]{1,23}$/),
    name: z.string().trim().min(2).max(40),
    /** What this structure is for, in a seller's words. */
    forWhom: z.string().trim().min(8).max(80),
    adFramework: z.enum(AD_FRAMEWORKS),
    temperature: z.enum(VISITOR_TEMPERATURES),
    length: z.enum(STRUCTURE_LENGTHS),

    /**
     * THE SECTIONS, IN ORDER, FROM THE LIBRARY THAT ALREADY EXISTS.
     *
     * Typed as the library's own `SectionType`, so a structure cannot
     * invent a block — and the day the library grows, every structure can
     * use the new one without a line changing here.
     */
    sequence: z
      .array(z.enum(Object.keys(SECTION_LABEL) as [SectionType, ...SectionType[]]))
      .min(3)
      .max(14),

    /** What the first screen leads with — a section type, not a shape. */
    heroKind: z.string().trim().min(2).max(24),

    slots: z.array(textSlotSchema).min(1).max(24),
    ctaRhythm: ctaRhythmSchema,

    /** Where the numbers and the proof appear, by section index. */
    proofAt: z.array(z.number().int().min(0).max(13)).min(1).max(5),
    /** Which kinds of proof this structure uses. */
    proofKinds: z.array(z.string()).min(1).max(5),

    firstScreen: firstScreenSchema,
  })
  .strict()
  .superRefine((s, ctx) => {
    const fail = (message: string, path: (string | number)[] = []) =>
      ctx.addIssue({ code: 'custom', message, path });

    // ── the page has one job ──
    if (!s.sequence.includes('form')) {
      fail('بنية بلا نموذج طلب — الصفحة هدفها واحد وهو الطلب', ['sequence']);
    }
    if (!s.sequence.includes('sticky')) {
      fail('زر الطلب الثابت مطلوب بكل بنية', ['sequence']);
    }
    if (!s.sequence.includes('footer')) {
      fail('التذييل القانوني مطلوب — بدونه لا تقبل المنصّات الإعلان', ['sequence']);
    }
    if (s.sequence[0] !== 'hero') {
      fail('البنية تبدأ بالبطل — الزائر وصل من إعلان ولا يبحث عن البداية', ['sequence', 0]);
    }

    // ── nothing repeats that may not ──
    const once: SectionType[] = ['hero', 'form', 'footer', 'sticky'];
    for (const type of once) {
      if (s.sequence.filter((t) => t === type).length > 1) {
        fail(`«${SECTION_LABEL[type]}» مرّة واحدة في الصفحة`, ['sequence']);
      }
    }

    // ── the proof is real ──
    for (const kind of s.proofKinds) {
      if (PROOF_ENGINE[kind] === undefined) fail(`دليلٌ غير معروف: ${kind}`, ['proofKinds']);
      else if (PROOF_ENGINE[kind] === null) fail(`دليلٌ لا يخدمه شيء بعد: ${kind}`, ['proofKinds']);
    }
    for (const at of s.proofAt) {
      if (at >= s.sequence.length) fail('موضع دليل خارج التسلسل', ['proofAt']);
    }

    // ── the copy ──
    const keys = s.slots.map((x) => x.key);
    if (new Set(keys).size !== keys.length) fail('خانتان بنفس المعرّف', ['slots']);

    // Two slots writing the same field of the same section is one of them
    // silently losing — and which one depends on the order they happen to
    // be listed in.
    const seats = s.slots.map((x) => `${x.at}.${x.field}`);
    if (new Set(seats).size !== seats.length) fail('خانتان تكتبان نفس الحقل من نفس القسم', ['slots']);
    for (const [i, slot] of s.slots.entries()) {
      // A slot long enough to hold a paragraph is not a headline, and a
      // headline that may hold digits is where an invented number goes.
      if (slot.mayContainDigits && slot.max <= 40) {
        fail('خانة قصيرة تقبل أرقاماً — هنا يُكتب الادّعاء', ['slots', i, 'mayContainDigits']);
      }
      // AN EXAMPLE THAT DOES NOT FIT IS NOT AN EXAMPLE. A guide showing a
      // sixty-character headline for a forty-character field teaches the
      // seller to write something the field will cut.
      if ([...slot.example].length > slot.max) {
        fail(`المثال أطول من حدّ الخانة (${[...slot.example].length} > ${slot.max})`, ['slots', i, 'example']);
      }
      // Copy with nowhere to land is copy a seller writes and never sees.
      if (slot.at >= s.sequence.length) {
        fail('خانة تشير إلى قسم خارج التسلسل', ['slots', i, 'at']);
      } else if (slot.at >= 0 && ['sticky', 'footer'].includes(s.sequence[slot.at])) {
        // The furniture is the engine's, not the seller's: a slot aimed
        // at the sticky button or the legal footer is copy that will not
        // be drawn.
        fail('خانة تكتب في الأثاث الثابت — الزر العائم والتذييل ليسا نصّ البائع', ['slots', i, 'at']);
      }
      // And an example that breaks the slot's own rule about digits.
      if (!slot.mayContainDigits && /[0-9٠-٩]/.test(slot.example)) {
        fail('المثال فيه رقم وخانته لا تقبل الأرقام', ['slots', i, 'example']);
      }
    }

    /**
     * A LONG PAGE EARNS ITS LENGTH — COUNTED IN CONTENT, NOT IN FURNITURE.
     *
     * `sticky` and `footer` are required of every structure; they are the
     * same two in a three-section page and a fourteen-section one, and
     * counting them against the label means a «short» page is allowed two
     * fewer paragraphs than it should be. The first structure written
     * against this contract was refused for exactly that, which is how the
     * rule was found: the page had six content sections and the schema
     * read eight.
     *
     * The seams overlap on purpose. «قصيرة · متوسطة · طويلة» is a label a
     * seller browses by, not a measurement, and a hard boundary would
     * refuse a sensible structure for being one section over.
     */
    const FURNITURE: SectionType[] = ['sticky', 'footer'];
    const content = s.sequence.filter((t) => !FURNITURE.includes(t)).length;
    const want = { short: [3, 6], medium: [6, 9], long: [8, 12] }[s.length];
    if (content < want[0] || content > want[1]) {
      fail(`بنية «${s.length}» بـ${content} أقسام محتوى — الطول والتسلسل لا يتفقان`, ['length']);
    }
  });

export type LandingStructure = z.infer<typeof landingStructureSchema>;

/**
 * A structure, parsed at module load. A bad one fails the BUILD, not a
 * test — the same rule the shop templates ship under.
 */
export function shippedStructure(value: unknown): LandingStructure {
  const parsed = landingStructureSchema.safeParse(value);
  if (!parsed.success) {
    const id = (value as { id?: string } | null)?.id ?? '?';
    throw new Error(
      `بنية «${id}» لا تحترم العقد: ${parsed.error.issues.map((i) => i.message).join(' · ')}`
    );
  }
  return parsed.data;
}

/**
 * The copy for a slot, in the dialect asked for, falling back to the one
 * every slot carries.
 *
 * A market with no copy written yet gets the simplified standard Arabic
 * rather than an empty page — and the caller cannot tell the difference,
 * which is deliberate: a page half in one dialect and half in another
 * reads as a page nobody proofread.
 */
export function copyIn(
  copy: Record<string, string> | undefined,
  dialect: Dialect
): string {
  if (!copy) return '';
  return copy[dialect]?.trim() || copy.msa?.trim() || '';
}


/**
 * A STRUCTURE, A SELLER'S WORDS, AND A DIALECT — INTO A PAGE.
 *
 * The third bridge of its kind and deliberately the same shape as the two
 * before it: `buildTemplate` turns a page shape into sections, and
 * `skinToSections` turns a shop template's section list into sections.
 * All three end at `LandingSection[]`, which is what `PageBlocks` already
 * draws — so a page built from a structure is an ordinary page afterwards
 * and every panel edits it the ordinary way.
 *
 * THE COPY IS CUT TO THE LIMIT IT WAS WRITTEN UNDER. A slot says `max`
 * and the editor should stop there; a seller who pasted a longer line into
 * the database (or changed the limit afterwards) gets it cut here rather
 * than a headline that overflows a 360px phone. Cut, never dropped: half
 * a sentence is a bug somebody notices, an empty hero is one they do not.
 *
 * WHAT IT DOES NOT CARRY IS A LOOK. The sections come out with the
 * library's own defaults; the skin paints them. `بنية × مظهر` is only a
 * promise if the structure half genuinely never touches a colour.
 */
export function structureToSections(
  structure: LandingStructure,
  copy: Record<string, Record<string, string> | undefined>,
  dialect: Dialect,
  make: (type: SectionType) => LandingSection
): LandingSection[] {
  const sections = structure.sequence.map((type) => make(type));
  // The blocks a slot wrote into, made whole at the end (see fillMissingFields).
  const touched = new Set<number>();

  for (const slot of structure.slots) {
    const section = sections[slot.at];
    if (!section) continue;
    const text = copyIn(copy[slot.key], dialect);
    if (!text) continue;
    const cut = [...text].slice(0, slot.max).join('');
    touched.add(slot.at);

    /*
     * `headline`, or `points.0.when` — one named field, or a cell of a list.
     *
     * The row is CREATED when it is written to, which is what lets a seller
     * fill the first two points of a timeline and leave the third: the block
     * ends with two rows rather than with a third that is a pair of empty
     * strings. An empty row in a drawn table is worse than a shorter table.
     */
    const [key, index, column] = slot.field.split('.');
    const target = section as unknown as Record<string, unknown>;
    if (index === undefined) {
      target[key] = cut;
      continue;
    }
    const rows = Array.isArray(target[key]) ? (target[key] as Record<string, unknown>[]) : [];
    const at = Number(index);
    while (rows.length <= at) rows.push({});
    rows[at] = { ...rows[at], [column]: cut };
    target[key] = rows;
  }

  /*
   * A LIST THE SELLER NEVER TOUCHED KEEPS THE LIBRARY'S OWN SEED, and a seed
   * is one empty row — which `newSection` writes so the editor has something
   * to type into. Drawn, that is a table with one blank line in it, so the
   * renderers drop rows whose first column is empty and the block disappears
   * when every row is. Nothing here needs to repeat that: what this function
   * must not do is leave a HOLE in the middle, which the loop above avoids by
   * filling up to the row it is writing.
   */

  return sections.map((section, at) => (touched.has(at) ? fillMissingFields(section) : section));
}

/**
 * A BLOCK WHOSE ROWS WERE WRITTEN ONE CELL AT A TIME, MADE WHOLE.
 *
 * A slot may address one cell (`points.0.when`), and the row is CREATED when
 * it is written to — as `{ when: "…" }`, every other column missing. The
 * block schema has a default for each of them and the renderers rely on it:
 * a list is drawn from a PARSED block, and a half-row threw inside the
 * preview and the creation dialog before the seller saw one word of it.
 *
 * So a block this module touched goes through the schema once, which fills
 * what is missing and changes nothing that is there. A block the schema
 * REFUSES is returned as it came: a copy that overflows a limit is for the
 * save endpoint to refuse in words, not for this function to lose.
 */
export function fillMissingFields(section: LandingSection): LandingSection {
  const parsed = landingSectionSchema.safeParse(section);
  return parsed.success ? parsed.data : section;
}

/**
 * THE SECTION TYPES THE TEN STRUCTURES NEED THAT THE LIBRARY DID NOT HAVE.
 *
 * Measured against the sequences the brief writes out: a comparison table
 * («نحن مقابل هم»), a timeline («رحلة التحوّل»), a three-tap quiz
 * («الاختبار»), an objection-and-answer list («كاسر الاعتراضات») and a
 * mechanism diagram («العلم خلفه»). Five of the ten could not be built as
 * described until these existed.
 *
 * THEY EXIST NOW. The list stays, and the test beside it changed sides:
 * it asserted that none of them was secretly already there, and now
 * asserts that every one of them IS. That is what made the delivery
 * visible — the guard went red the moment the gap closed, which is more
 * than a note in a file would have done.
 *
 * It lives here because the contract is where the gap was discovered:
 * `sequence` only accepts what the library draws, so a structure needing
 * one of these could not be parsed, and the error a person met named the
 * thing that was missing.
 */
export const SECTIONS_THE_TEN_NEED = Object.freeze({
  comparison: 'جدول «منتجنا / البدائل» — «نحن مقابل هم»',
  timeline: 'خط زمني: الأسبوع الأول · الثالث · الثامن — «رحلة التحوّل»',
  quiz: 'ثلاثة أسئلة بضغطة ثم التوصية — «الاختبار»',
  objections: '«ممكن تكون عم تفكر…» × خمسة اعتراضات وجوابها',
  mechanism: 'رسم كيف يشتغل، والمكوّنات وما يفعله كل واحد — «العلم خلفه»',
});
