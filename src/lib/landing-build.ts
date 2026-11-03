import { normalizeArabic } from './order-parser';
import { TONE_SENTENCE, type Tone } from './landing-copy-brief';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «ابنيلي صفحة الهبوط» — THE PROPOSAL, AND THE RULE THAT A PROMISE MUST BE
 * WRITTEN SOMEWHERE.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The owner's addition to S3, 15/10 (`S3-BUILD-MY-LANDING-PAGE.md`): he
 * picks a product, presses one button, and the model reads THE PRODUCT PAGE
 * THIS SYSTEM ALREADY HAS — its written specs and its main photograph — and
 * fills in the page's fields.
 *
 * Four of his sentences are the whole of this file, and each one is a rule
 * that a generator without it would break on its first real product:
 *
 *   ① «المكتوب بصفحة المنتج بيغلب على المقروء من الصورة.» The written spec
 *      wins. A model reading a 50 ml bottle in a photograph of a 150 ml jar
 *      is not wrong about the photograph — it is reading a different bottle,
 *      and the seller's own field is the one the warehouse ships.
 *
 *   ② «وإذا في تعارض بينهم (زي الحجم) → تنبيه للمالك، مش اختيار صامت.»
 *      So a conflict is not resolved quietly in favour of ①: ① decides the
 *      VALUE and the disagreement is RAISED. A silent winner is how a
 *      seller finds out six weeks later that half his pages say 50 ml.
 *
 *   ③ «الوعد لازم يكون مكتوباً بمكان — وإلا فهو اقتراح.» A promise found in
 *      the product page enters as «من صفحة المنتج»; one found in the box
 *      text the model returned enters as «من العلبة»; anything else is
 *      «اقتراح» and does NOT enter the page without the owner's press.
 *      ⚠️ And a HEALTH claim that is in neither is refused outright — not
 *      offered as a suggestion. «ممنوع أي ادّعاء صحّي مش مكتوب بواحد من
 *      الاتنين.»
 *
 *   ④ «ولهيك الموديل لازم يرجّع النصّ الخامّ.» The verbatim box text is not
 *      a nicety: without it there is NO WAY to tell a promise read off the
 *      box from one the model invented, and ③ becomes a comment. So the
 *      text comes back as it was read, and every «من العلبة» below is
 *      checked against it rather than trusted.
 *
 * AND THE COLOURS ARE NOT HERE. «الألوان بالكود، مش بالموديل» — they are
 * derived from the photograph by `landing-world-colors.ts`, and a colour
 * key in the model's answer is dropped and named like any other invention.
 */

/* ───────────────────────────── matching ───────────────────────────── */

/**
 * ONE FOLD FOR BOTH SIDES OF EVERY COMPARISON.
 *
 * `normalizeArabic` (order-parser.ts) already unifies the letters this
 * language writes four ways — أ/إ/آ/ا, ى/ي, ة/ه — and strips diacritics
 * and tatweel. It is reused rather than re-written: the one thing worse
 * than no normaliser is two that disagree, and the order parser's has been
 * read by more real Arabic than anything else in this repository.
 *
 * What is added here is what a BOX needs and a WhatsApp message does not:
 *
 *   · Arabic-Indic digits folded to Western, because «١٥٠ مل» on a label
 *     and «150 مل» in the field are the same bottle;
 *   · punctuation and separators to spaces, because a label reads «150مل»,
 *     «150 مل.» and «(150 مل)» and none of those is a different size.
 */
export function foldForMatch(text: string): string {
  return normalizeArabic(String(text ?? ''))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The words of a phrase worth matching on — the short ones carry nothing. */
const contentWords = (text: string) => foldForMatch(text).split(' ').filter((w) => w.length >= 3);

/**
 * IS THIS SENTENCE WRITTEN IN THAT TEXT?
 *
 * Two passes, and the order is the careful part. Over-accepting here is the
 * dangerous direction: it would stamp «من العلبة» on a promise nobody wrote,
 * which is the exact failure ③ exists to prevent.
 *
 *   · First the folded phrase as a SUBSTRING — the honest case.
 *   · Then its content words as an ORDERED SUBSEQUENCE of the source's
 *     words. «تقوية الشعر» matches «بتقوّي الشعر وبتغذّيه» because the two
 *     words appear, in that order, in a box that says the same thing with
 *     a word in between. A bag-of-words test would also match a box where
 *     «الشعر» comes first and «تقوية» is about something else entirely.
 *
 * A phrase with no content words at all («١ · ٢ · ٣») matches nothing.
 */
export function writtenIn(sentence: string, source: string): boolean {
  const needle = foldForMatch(sentence);
  if (!needle) return false;
  const hay = foldForMatch(source);
  if (!hay) return false;
  if (hay.includes(needle)) return true;

  const words = contentWords(sentence);
  if (words.length === 0) return false;
  const hayWords = hay.split(' ');
  let at = 0;
  for (const word of words) {
    const found = hayWords.indexOf(word, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

/**
 * TWO WRITTEN VALUES THAT MEAN THE SAME THING — for the conflict check (②).
 *
 * ⚠️ A NUMBER IS COMPARED AS A NUMBER, NEVER AS A SUBSTRING. «50 مل» is
 * inside «150 مل», and the first version of this function read that as
 * agreement — which turned the one conflict the owner names by example
 * («زي الحجم») into a silent pass. So: spaces ignored, and the moment
 * either side carries a digit the two must be IDENTICAL to count as the
 * same value.
 *
 * Containment is kept for prose, where it is the normal case rather than a
 * trap: a field saying «الأردن» and a box saying «صُنع في الأردن» are not a
 * disagreement about the country, and raising a notice for it would teach
 * the owner that the notices are noise.
 */
function sameValue(a: string, b: string): boolean {
  const tight = (s: string) => foldForMatch(s).replace(/ /g, '');
  const x = tight(a);
  const y = tight(b);
  if (!x || !y) return true;
  if (x === y) return true;
  if (/[0-9]/.test(x) || /[0-9]/.test(y)) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * A HEALTH CLAIM, BY THE WORDS THIS PRODUCT ALREADY FORBIDS.
 *
 * The same vocabulary `ai-prompts.ts` and `landing-copy-brief.ts` forbid a
 * model from writing: «يشفي» · «يعالج» · a named disease · a medicine. It
 * is a short list on purpose — it is a REFUSAL, and a long list of loose
 * stems would refuse «يغذّي الشعر» and teach the owner to ignore the
 * refusals.
 */
const HEALTH_WORDS = [
  'يشفي',
  'شفاء',
  'يعالج',
  'علاج',
  'مرض',
  'امراض',
  'دواء',
  'طبي',
  'يقضي علي',
  'مضاد حيوي',
  'فيروس',
  'التهاب',
  'سرطان',
  'سكري',
  'ضغط الدم',
];

export function isHealthClaim(sentence: string): boolean {
  const folded = foldForMatch(sentence);
  return HEALTH_WORDS.some((w) => folded.includes(foldForMatch(w)));
}

/* ─────────────────────────── what goes in ─────────────────────────── */

/**
 * THE PRODUCT PAGE AS THIS SYSTEM ALREADY HOLDS IT — and nothing else.
 *
 * ⚠️ «ما في رفع صور من جديد»: the source is the product page and its own
 * photograph. There is no upload in this flow, and S1 §11 is explicit that
 * the matcher never asks for a face photo.
 */
export interface WrittenSpecs {
  /** The Arabic name. Always written — a product cannot exist without one. */
  name: string;
  /** `nameEn`, which is where the Latin name lives. */
  nameLatin?: string | null;
  description?: string | null;
  /** The category's NAME, never its id. */
  category?: string | null;
  /** The five answers the brief allows, key → written answer. */
  attributes?: Readonly<Record<string, string>>;
}

/**
 * THE SEVEN FIELDS, AND WHERE EACH ONE IS ALREADY WRITTEN.
 *
 * `written` names the spec that BEATS the photograph for that field (①).
 * `null` means nothing in the system answers it, so the photograph is the
 * only source there is — «الجملة» is the one: a seller writes a tagline
 * nowhere, which is why it is worth proposing one.
 */
export const BUILD_FIELDS = [
  { key: 'nameAr', label: 'الاسم عربي', written: 'name' },
  { key: 'nameLatin', label: 'الاسم لاتيني', written: 'nameLatin' },
  { key: 'tagline', label: 'الجملة', written: null },
  { key: 'size', label: 'الحجم', written: 'attr:ml' },
  { key: 'ingredients', label: 'المكوّنات', written: 'attr:ingredients' },
  { key: 'madeIn', label: 'بلد الصنع', written: 'attr:made' },
  { key: 'category', label: 'الفئة', written: 'category' },
] as const;

export type BuildFieldKey = (typeof BUILD_FIELDS)[number]['key'];

/** The written answer for one field, or null when the system has none. */
export function writtenValue(specs: WrittenSpecs, field: (typeof BUILD_FIELDS)[number]): string | null {
  const from = field.written;
  if (!from) return null;
  if (from.startsWith('attr:')) {
    const value = specs.attributes?.[from.slice(5)];
    return value && String(value).trim() ? String(value).trim() : null;
  }
  const value = (specs as unknown as Record<string, unknown>)[from];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Everything the product page says, as one text to check a promise against. */
export function productPageText(specs: WrittenSpecs): string {
  return [
    specs.name,
    specs.nameLatin ?? '',
    specs.description ?? '',
    specs.category ?? '',
    ...Object.values(specs.attributes ?? {}),
  ]
    .filter((p) => String(p ?? '').trim() !== '')
    .join(' · ');
}

/**
 * THE QUESTIONS THE OWNER ANSWERS — S1 §11.
 *
 * «شكل أبيض نظيف وأرقام جنب الصورة، بس بأسئلة. ولا رفع صورة وجه.» So the
 * matcher is not a form of settings: it is five questions, numbered beside
 * the product's own photograph, and every one of them is about the PRODUCT.
 *
 * They live beside the brief rather than in the screen because the brief
 * quotes them: a question whose wording the model never sees is a question
 * the owner answered for nothing.
 */
export const BUILD_QUESTIONS = [
  { key: 'buyer', label: 'مين بيشتريه؟', hint: 'مثال: شباب بيصبغوا شعرهم' },
  { key: 'problem', label: 'شو المشكلة اللي بيحلّها؟', hint: 'مثال: الشعر بيتقصّف من السيشوار' },
  { key: 'different', label: 'ليش هو مش متل غيره؟', hint: 'مثال: بخلاصة أرز، وصنع بالأردن' },
  { key: 'proof', label: 'في إشي بتقدر تثبته؟', hint: 'ضمان · إرجاع · تجربة — واللي بتثبته بس' },
  { key: 'action', label: 'شو بتحبّ الزائر يعمل؟', hint: 'مثال: يطلب كاش عند الاستلام' },
] as const;

export type BuildAnswers = Partial<Record<(typeof BUILD_QUESTIONS)[number]['key'], string>>;

/** The longest an answer may be. Five lines of context, not a document. */
export const ANSWER_MAX = 300;

/**
 * THE ONE THING AN ANSWER MAY NOT CARRY — AND IT IS REFUSED, NOT STRIPPED.
 *
 * The owner's rule is absolute: «ولا اسم ولا رقم ولا عنوان» to a model that
 * is not his own machine. The questions above ask about a PRODUCT, so there
 * is no field here for a customer — but a free-text box is a free-text box,
 * and the one thing a seller pastes into one by habit is a phone number.
 *
 * A run of seven or more digits is a phone, an order reference or an
 * account, and none of the three is an answer to «مين بيشتريه؟». It is
 * refused with its reason rather than quietly deleted: a seller whose
 * sentence came back altered does not know what was taken out of it.
 */
export function answersRefusal(answers: BuildAnswers): string | null {
  for (const q of BUILD_QUESTIONS) {
    const text = String(answers[q.key] ?? '');
    if (!text.trim()) continue;
    if (text.length > ANSWER_MAX) {
      return `«${q.label}» أطول من ${ANSWER_MAX} حرفاً — قصّرها.`;
    }
    /*
     * SEVEN DIGITS IN A ROW, SPACES ALLOWED BETWEEN THEM — «0799 123 456»
     * is one number, and `replace(/\D/g, '')` on the whole sentence would
     * instead glue «150 مل» and «3 قطع» into a false positive.
     */
    if (/(?:[0-9] ?){7,}/.test(foldForMatch(text))) {
      return `«${q.label}» فيها رقم طويل — ولا رقم زبون ولا تلفون بيروح لأي نموذج. شيله.`;
    }
  }
  return null;
}

/* ──────────────────────────── the brief ──────────────────────────── */

export interface BuildBriefInput {
  specs: WrittenSpecs;
  answers?: BuildAnswers;
  /**
   * Is the main photograph going with this call?
   *
   * False for two different reasons and the brief must say which: the
   * product has no photograph, or the owner's chosen model does not read
   * images at all (`ai-vision.ts`). Either way the model works from the
   * written specs ALONE and must not pretend to have seen a box — so it is
   * told, and the screen is told too.
   */
  hasImage: boolean;
  /** The wizard's «الأسلوب»: one sentence, and the rules below stay as they are. */
  tone?: Tone;
}

export function buildPageBrief(input: BuildBriefInput): string {
  const { specs, answers, hasImage, tone } = input;
  const attrs = Object.entries(specs.attributes ?? {}).filter(([, v]) => String(v ?? '').trim() !== '');
  const said = BUILD_QUESTIONS.map((q) => [q, String(answers?.[q.key] ?? '').trim()] as const).filter(
    ([, v]) => v !== ''
  );

  return [
    'املأ حقول صفحة هبوط لمنتج واحد، من مصدرين فقط: المواصفات المكتوبة تحت، وصورة العلبة المرفقة.',
    ...(tone ? [TONE_SENTENCE[tone]] : []),
    '',
    '## المواصفات المكتوبة بصفحة المنتج',
    `- الاسم عربي: ${specs.name}`,
    specs.nameLatin?.trim() ? `- الاسم لاتيني: ${specs.nameLatin.trim()}` : '- لا اسم لاتيني مكتوب.',
    specs.description?.trim() ? `- الوصف: ${specs.description.trim()}` : '- لا وصف مكتوب.',
    specs.category?.trim() ? `- الفئة: ${specs.category.trim()}` : '- لا فئة مكتوبة.',
    ...attrs.map(([k, v]) => `- ${k}: ${v}`),
    '',
    ...(said.length > 0
      ? ['## وكلام المالك عن منتجه', ...said.map(([q, v]) => `- ${q.label} ${v}`), '']
      : []),
    '## الصورة',
    hasImage
      ? 'معك صورة العلبة الرئيسيّة. اقرأ المكتوب عليها، وأكمل منها ما ينقص المواصفات فوق.'
      : 'لا صورة معك. اشتغل من المواصفات المكتوبة وحدها، وأرجِع packageText فارغاً — ولا تتخيّل علبة.',
    '',
    '## القواعد',
    '1. المكتوب بالمواصفات يغلب على المقروء من الصورة. لا تصحّح المكتوب.',
    '2. إن اختلف المكتوب عمّا قرأته على العلبة، أرجِع ما قرأته كما هو — سيُنبَّه المالك، ولا تختر بنفسك.',
    '3. الوعود: لا تكتب وعداً إلا إن كان مكتوباً بالمواصفات أو مقروءاً على العلبة. لحد ثلاثة وعود.',
    '4. ممنوع ادّعاء صحّي: لا «يشفي» ولا «يعالج» ولا ذكر مرض ولا دواء.',
    '5. لا رقم من عندك: لا نسبة ولا عدد مشترين ولا تقييم.',
    '6. لا لون ولا خطّ — الألوان تُحسب من الصورة بالكود، وليست لك.',
    '7. packageText هو النصّ الذي قرأته على العلبة حرفيّاً كما هو، بلا ترتيب ولا تحسين. وهو ما يُتحقَّق منه الوعد.',
    '',
    '## شكل الجواب',
    'كائن JSON واحد ولا شيء غيره، بهذه المفاتيح:',
    `{ ${BUILD_FIELDS.map((f) => `"${f.key}": "…"`).join(', ')}, "promises": ["…"], "packageText": "…" }`,
    'المفتاح الذي لا جواب له: اتركه فارغاً أو لا تُرسله. ولا تضف مفتاحاً غير هذه.',
  ].join('\n');
}

/* ──────────────────────── reading the answer ──────────────────────── */

/** Where a value came from — and «suggestion» is the one that waits. */
export type BuildSource = 'product' | 'package' | 'suggestion';

export const SOURCE_LABEL: Readonly<Record<BuildSource, string>> = Object.freeze({
  product: 'من صفحة المنتج',
  package: 'من العلبة',
  suggestion: 'اقتراح',
});

export interface BuiltField {
  key: BuildFieldKey;
  label: string;
  value: string;
  source: BuildSource;
}

export interface BuiltPromise {
  text: string;
  source: BuildSource;
  /** A promise enters the page only when it was written in one of the two. */
  enters: boolean;
  /** Set when it is refused outright rather than offered — a health claim. */
  refused?: string;
}

export interface BuildNotice {
  key: BuildFieldKey;
  label: string;
  /** What the product page says — and what the page will carry. */
  written: string;
  /** What the model read on the box. */
  read: string;
}

export interface BuildReading {
  fields: BuiltField[];
  promises: BuiltPromise[];
  /** The box text, verbatim. Empty when the model had no image or read none. */
  packageText: string;
  notices: BuildNotice[];
  /** Fields nothing answered — written by hand, and named. */
  missing: string[];
  /** Keys the model invented, and values it was not asked for. */
  dropped: string[];
}

/** The longest box text worth keeping. A label is not a book. */
const PACKAGE_MAX = 2000;
const FIELD_MAX = 200;
const PROMISE_MAX = 120;
export const MAX_PROMISES = 3;

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/**
 * READ THE ANSWER AGAINST THE TWO SOURCES — NOTHING IS TRUSTED.
 *
 * The shape of the refusals matters more than the shape of the answer, so
 * they are listed where they happen. The one worth reading twice is the
 * promise loop: it is the acceptance test of the whole feature (§٧), and
 * what it says is that a model which returns a promise present in NEITHER
 * source has made a suggestion — not a promise, not a page, not a claim.
 */
export function readBuildAnswer(raw: unknown, specs: WrittenSpecs): BuildReading {
  const reading: BuildReading = {
    fields: [],
    promises: [],
    packageText: '',
    notices: [],
    missing: [],
    dropped: [],
  };

  const answer: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  /*
   * ④ THE VERBATIM TEXT, FIRST — because everything below is checked
   * against it. Whitespace is collapsed and nothing else is touched: a
   * «tidied» box text is no longer evidence.
   */
  reading.packageText = text(answer.packageText, PACKAGE_MAX);

  const declared = new Set<string>([...BUILD_FIELDS.map((f) => f.key), 'promises', 'packageText']);
  for (const key of Object.keys(answer)) {
    if (!declared.has(key)) {
      /*
       * A KEY WE DID NOT ASK FOR IS DROPPED AND NAMED — and `accent`,
       * `color` and `theme` are the three this feature expects to see.
       * «الألوان بالكود، مش بالموديل»: a colour that arrived in the answer
       * is not a colour this page will ever wear, and dropping it silently
       * would leave the owner thinking the model chose his palette.
       */
      reading.dropped.push(`أُهمل مفتاح لم يُطلب: ${key}`);
    }
  }

  for (const field of BUILD_FIELDS) {
    const written = writtenValue(specs, field);
    const read = text(answer[field.key], FIELD_MAX);

    if (written && read && !sameValue(written, read)) {
      // ② THE CONFLICT IS RAISED, AND ① STILL DECIDES THE VALUE.
      reading.notices.push({ key: field.key, label: field.label, written, read });
      reading.fields.push({ key: field.key, label: field.label, value: written, source: 'product' });
      continue;
    }
    if (written) {
      reading.fields.push({ key: field.key, label: field.label, value: written, source: 'product' });
      continue;
    }
    if (read) {
      const onBox = reading.packageText !== '' && writtenIn(read, reading.packageText);
      reading.fields.push({
        key: field.key,
        label: field.label,
        value: read,
        source: onBox ? 'package' : 'suggestion',
      });
      continue;
    }
    reading.missing.push(field.label);
  }

  const promises = Array.isArray(answer.promises) ? answer.promises : [];
  if (answer.promises !== undefined && !Array.isArray(answer.promises)) {
    reading.dropped.push('الوعود لم تَعُد قائمةً — أُهملت كلّها.');
  }
  const pageText = productPageText(specs);
  const seen = new Set<string>();

  for (const row of promises) {
    const promise = text(row, PROMISE_MAX);
    if (!promise) continue;
    const folded = foldForMatch(promise);
    if (seen.has(folded)) continue;
    seen.add(folded);
    if (reading.promises.length >= MAX_PROMISES) {
      reading.dropped.push(`وعدٌ زائد عن ${MAX_PROMISES} — أُهمل: «${promise}»`);
      continue;
    }

    const source: BuildSource = writtenIn(promise, pageText)
      ? 'product'
      : reading.packageText !== '' && writtenIn(promise, reading.packageText)
        ? 'package'
        : 'suggestion';

    /*
     * ③ AND THE HEALTH CLAIM NOBODY WROTE IS NOT EVEN A SUGGESTION.
     *
     * The other suggestions wait for a press; this one has nowhere to be
     * pressed from, because «ممنوع أي ادّعاء صحّي مش مكتوب بواحد من
     * الاتنين» is not a preference the owner can overrule — it is what
     * keeps an advert running and a shop out of court.
     */
    if (source === 'suggestion' && isHealthClaim(promise)) {
      reading.promises.push({
        text: promise,
        source,
        enters: false,
        refused: 'ادّعاء صحّي غير مكتوب لا بصفحة المنتج ولا على العلبة — مرفوض، ولا يُعرض للموافقة.',
      });
      continue;
    }

    reading.promises.push({ text: promise, source, enters: source !== 'suggestion' });
  }

  return reading;
}

/**
 * WHAT HAPPENED, IN THE LINES THE OWNER READS ABOVE THE FIELDS.
 *
 * Not a banner and not a toast: a proposal with one conflict and two
 * suggestions is a short list of DECISIONS, and a message that disappears
 * after four seconds is a list nobody keeps.
 */
export function buildNoteAr(reading: BuildReading): string[] {
  const out: string[] = [];
  const fromPage = reading.fields.filter((f) => f.source === 'product').length;
  const fromBox = reading.fields.filter((f) => f.source === 'package').length;
  out.push(`${reading.fields.length} حقل جاهز — ${fromPage} من صفحة المنتج و${fromBox} من العلبة.`);

  if (reading.packageText === '') {
    out.push('ما في نصّ علبة مقروء، فكلّ وعد مش مكتوب بصفحة المنتج صار «اقتراح».');
  }
  for (const n of reading.notices) {
    out.push(`تعارض بـ«${n.label}»: المكتوب «${n.written}» والمقروء من الصورة «${n.read}» — المكتوب هو المعتمد، راجعه.`);
  }
  const waiting = reading.promises.filter((p) => p.source === 'suggestion' && !p.refused);
  if (waiting.length > 0) {
    out.push(`${waiting.length} وعد «اقتراح» — ما بيدخل الصفحة إلا بموافقتك.`);
  }
  for (const p of reading.promises.filter((x) => x.refused)) {
    out.push(`مرفوض: «${p.text}» — ${p.refused}`);
  }
  if (reading.missing.length > 0) {
    out.push(`اكتب بنفسك: ${reading.missing.join('، ')}.`);
  }
  if (reading.dropped.length > 0) {
    out.push(reading.dropped.join(' · '));
  }
  return out;
}
