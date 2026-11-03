import { DIALECT_LABEL, type Dialect, type LandingStructure, type TextSlot } from './landing-structure';

/**
 * ASK A MODEL FOR THE PAGE'S WORDS — NOT FOR A PAGE.
 *
 * «مولّد صفحة الهبوط بالذكاء الاصطناعيّ». The hook for it was already
 * declared and never called: `ai-prompts.ts` carries a `landing_html` job
 * whose `default` is an EMPTY STRING and which nothing in the product
 * invokes. So the setting existed and the generator did not.
 *
 * ── WHY IT GENERATES SLOT COPY AND NOT HTML ──
 *
 * There is already a `landing_html` path, and it is a different thing: a
 * brief (`landing-html-prompt.ts`) that a seller COPIES to an outside model,
 * gets a file back, and uploads — after which `landing-html-sanitize.ts`
 * strips everything it must. That path exists for a seller who wants a page
 * nobody here designed.
 *
 * This one fills the ten structures. Each structure declares its slots, and
 * EVERY SLOT ALREADY CARRIES ITS OWN BRIEF: a label, what the sentence has
 * to do, what it must avoid, an example in Levantine, and a character limit.
 * That is a better prompt than anything written for a model, because it was
 * written by the person who sells the product.
 *
 * Asking for HTML instead would mean a second landing system — a page the
 * structure engine cannot read, the skins cannot paint, the editor cannot
 * edit slot by slot, and the sanitizer has to defend against. The whole
 * «بنية × مظهر» promise is that the words and the look are separate; a
 * generator that produced both would be the first thing to break it.
 *
 * ── AND IT PROPOSES. IT DOES NOT WRITE ──
 *
 * `ai-proposal-only.test.ts` holds «كلّ إجراء ذكاءٍ اصطناعيٍّ اقتراحٌ فقط»
 * as an INVARIANT with a sweep behind it: a file that calls a model writes
 * nothing. So this module returns copy, the door returns copy, and the
 * seller saves it through the draft path that already exists — where it
 * lands in `contentDraft` and nobody sees it until they publish.
 *
 * ── WHAT COMES BACK IS CHECKED AGAINST THE STRUCTURE, NOT TRUSTED ──
 *
 * A model asked for nine keys will sometimes send eight, sometimes ten,
 * sometimes a key it invented, and sometimes a headline twice the length the
 * slot allows. `readProposal` keeps what the structure declared, cuts what
 * is too long, and NAMES everything it dropped — because a generator that
 * silently discards a third of its answer is one nobody can debug.
 */

/** The facts about the product that the words have to be true about. */
export interface ProductFacts {
  name: string;
  /** What it is, in the seller's own words. Empty is allowed and said so. */
  description?: string | null;
  price: number;
  currency: string;
  /** What the shop already answers about it — «مناسب لـ», ingredients, size. */
  attributes?: Readonly<Record<string, string>>;
}

export interface BriefInput {
  structure: LandingStructure;
  product: ProductFacts;
  dialect: Dialect;
  /** How the words should sound. One sentence in the brief; the rules below do not move. */
  tone?: Tone;
  /** What the seller wants stressed, about the product only. Checked by `notesRefusal` first. */
  notes?: string;
}

/**
 * THE FOUR VOICES THE WIZARD OFFERS — «الأسلوب».
 *
 * Taken from the owner's other platform as it names them. A voice changes
 * how a sentence sounds and nothing it is allowed to claim: the rules are
 * listed after it, unchanged, so «عرض مقنع» cannot become a licence to
 * invent a discount.
 */
export const TONES = ['friendly', 'offer', 'premium', 'expert'] as const;
export type Tone = (typeof TONES)[number];

export const TONE_LABEL: Record<Tone, string> = {
  friendly: 'ودود',
  offer: 'عرض مقنع',
  premium: 'فاخر',
  expert: 'خبير وواقعي',
};

export const TONE_SENTENCE: Record<Tone, string> = {
  friendly: 'الأسلوب: ودود وقريب، كأنك عم تحكي مع صاحبك.',
  offer: 'الأسلوب: عرض مقنع — جمل قصيرة بتدفع للطلب، من غير ما تخترع خصم ولا رقم.',
  premium: 'الأسلوب: فاخر وهادي، كلمات قليلة ومنتقاة.',
  expert: 'الأسلوب: خبير وواقعي — حقائق المنتج كما هي، من غير مبالغة.',
};

/** The longest note the brief carries. */
export const NOTES_MAX = 300;

/**
 * A NOTE GOES TO A MODEL, SO IT IS READ BEFORE IT GOES.
 *
 * The box is for the product — «ركّز على إنه بيدوم سنة». A phone number in
 * it is a customer's or the seller's, and neither belongs in a brief, so
 * SEVEN DIGITS IN THE WHOLE NOTE refuse the call rather than being sent.
 *
 * Every non-digit is stripped before counting, on purpose. A pattern of
 * «digits with one separator between» was walked round by a double space,
 * a slash, or Persian digits; counting what is left cannot be. Arabic-Indic
 * (U+0660–0669) and Persian (U+06F0–06F9) digits are read as Western. The
 * price: a note that names «150 مل و3 قطع و2000 ليرة» is refused too — a
 * note is for what to stress, and it can say so in words.
 */
export function notesRefusal(notes: string | undefined | null): string | null {
  const text = String(notes ?? '');
  if (!text.trim()) return null;
  if (text.length > NOTES_MAX) return `الملاحظات أطول من ${NOTES_MAX} حرف — قصّرها.`;
  const western = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (western.replace(/[^0-9]/g, '').length >= 7) {
    return 'بالملاحظات رقم طويل — ولا رقم زبون ولا تلفون بيروح لأي نموذج. شيله.';
  }
  return null;
}

/**
 * THE RULES THE MODEL IS HELD TO, and every one of them is a rule this
 * product already enforces somewhere else.
 *
 * They are listed before the slots rather than after, because a model that
 * has already written nine headlines does not re-read the constraints.
 */
const RULES = [
  'اكتب نصّ الخانات فقط. لا HTML، لا CSS، لا أكواد، لا رموز ماركداون.',
  'لا تخترع رقماً: لا نسبة نجاح، ولا عدد مشترين، ولا «90٪ من الناس». الأرقام التي تملكها هي المعطاة لك وحدها.',
  'لا وعد طبّي ولا ذكر مرض ولا كلمة «يشفي» أو «يعالج».',
  'لا اسم علامة منافسة، ولا مقارنة باسم.',
  'لا تذكر السعر إلّا في خانة يطلب وصفها ذلك صراحةً — السعر يُعرض في بطاقة العرض.',
  'التزم بالحدّ الأقصى لحروف كلّ خانة. السطر الأطول يُقَصّ، والمقصوص نصف جملة.',
  'كلّ خانة جملةٌ مستقلّة تقرأ وحدها — لا «كما ذكرنا» ولا «في الأعلى».',
] as const;

/**
 * ONE SLOT, AS THE MODEL READS IT.
 *
 * The slot's own four fields, verbatim. Not rewritten, not summarised: the
 * `avoid` line in particular is the specific way this slot goes wrong, and
 * a paraphrase of it is a different instruction.
 */
function slotBrief(slot: TextSlot): string {
  return [
    `### ${slot.key} — ${slot.label}`,
    `- الغرض: ${slot.purpose}`,
    `- ممنوع: ${slot.avoid}`,
    `- مثال: ${slot.example}`,
    `- الحدّ الأقصى: ${slot.max} حرفاً`,
  ].join('\n');
}

/**
 * THE WHOLE BRIEF, as the user message of one call.
 *
 * Built from the structure rather than stored, so a slot added to a
 * structure is in the brief the same day — the failure mode of a stored
 * prompt is that it describes last month's structure.
 */
export function landingCopyBrief(input: BriefInput): string {
  const { structure, product, dialect, tone } = input;
  const notes = input.notes?.trim();
  const attrs = Object.entries(product.attributes ?? {}).filter(([, v]) => String(v ?? '').trim() !== '');

  return [
    `اكتب نصوص صفحة هبوط بالبنية «${structure.name}».`,
    `لمن هذه البنية: ${structure.forWhom}`,
    `اللهجة المطلوبة: ${DIALECT_LABEL[dialect]} — اكتب بها، لا بالفصحى.`,
    ...(tone ? [TONE_SENTENCE[tone]] : []),
    '',
    '## المنتج',
    `- الاسم: ${product.name}`,
    product.description?.trim()
      ? `- وصفه كما كتبه البائع: ${product.description.trim()}`
      : '- لا وصف مكتوب له. لا تخترع له واحداً؛ اكتب عمّا تعرفه من اسمه فقط.',
    `- سعره: ${product.price} ${product.currency}`,
    ...attrs.map(([k, v]) => `- ${k}: ${v}`),
    ...(notes
      ? [
          '',
          '## ملاحظات البائع',
          `${notes}`,
          'خذ منها شو يركّز عليه النص بس. القواعد تحت أقوى منها: رقم أو خصم أو وعد مش بوصف المنتج ما بينكتب.',
        ]
      : []),
    '',
    '## القواعد',
    ...RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    '## الخانات المطلوبة',
    ...structure.slots.map(slotBrief),
    '',
    '## شكل الجواب',
    'أجب بكائن JSON واحد ولا شيء غيره: المفاتيح هي معرّفات الخانات أعلاه حرفياً،',
    'والقيم نصوصها. لا تضف مفتاحاً لم يُطلب، ولا تترك مفتاحاً مطلوباً.',
    `المفاتيح المطلوبة: ${structure.slots.map((s) => s.key).join('، ')}`,
  ].join('\n');
}

export interface ProposalReading {
  /** Slot key → the text to put in it, already cut to the slot's limit. */
  copy: Record<string, string>;
  /** Slots the model did not answer. The seller writes these by hand. */
  missing: string[];
  /** Keys it sent that this structure does not have. Dropped, and named. */
  unknown: string[];
  /** Slots whose answer was too long and was cut, with both lengths. */
  cut: { key: string; was: number; max: number }[];
  /** Slots whose answer was present but empty or whitespace. */
  blank: string[];
}

/**
 * READ WHAT CAME BACK, AGAINST THE STRUCTURE THAT ASKED.
 *
 * Nothing here trusts the model:
 *
 *   A KEY THE STRUCTURE DOES NOT DECLARE IS DROPPED, not stored. The copy
 *   map is handed to `structureToSections`, which looks up the keys the
 *   slots name — so an invented key would be stored for ever and rendered
 *   never, which is worse than being refused.
 *
 *   A VALUE THAT IS NOT A STRING IS DROPPED. A model that answers a nested
 *   object for one slot has answered nothing for it.
 *
 *   A VALUE TOO LONG IS CUT AND SAID SO. `structureToSections` cuts to
 *   `max` anyway — its own comment says «Cut, never dropped: half a
 *   sentence is a bug somebody notices, an empty hero is one they do not».
 *   Cutting here too is not a second rule; it is so the seller is TOLD,
 *   at the moment the proposal lands, rather than discovering a chopped
 *   headline after publishing.
 *
 *   AND EVERY DROPPED THING IS NAMED. A generator that quietly keeps six
 *   of nine slots looks like a model that writes badly.
 */
export function readProposal(structure: LandingStructure, raw: unknown): ProposalReading {
  const reading: ProposalReading = { copy: {}, missing: [], unknown: [], cut: [], blank: [] };
  const answer: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const declared = new Map(structure.slots.map((s) => [s.key, s]));

  for (const key of Object.keys(answer)) {
    if (!declared.has(key)) reading.unknown.push(key);
  }

  for (const slot of structure.slots) {
    const value = answer[slot.key];
    if (typeof value !== 'string') {
      reading.missing.push(slot.key);
      continue;
    }
    const text = value.trim();
    if (text === '') {
      reading.blank.push(slot.key);
      continue;
    }
    if (text.length > slot.max) {
      reading.cut.push({ key: slot.key, was: text.length, max: slot.max });
      reading.copy[slot.key] = text.slice(0, slot.max);
      continue;
    }
    reading.copy[slot.key] = text;
  }

  return reading;
}

/**
 * WHAT HAPPENED, IN ONE LINE THE SELLER READS ABOVE THE FIELDS.
 *
 * Not an error banner: a proposal with two slots missing is still worth
 * keeping. The sentence says which fields they have to write themselves,
 * which is the only actionable part.
 */
export function proposalNoteAr(reading: ProposalReading, structure: LandingStructure): string {
  const wrote = Object.keys(reading.copy).length;
  const total = structure.slots.length;
  const parts = [`كُتبت ${wrote} من ${total} خانة.`];

  const byHand = [...reading.missing, ...reading.blank];
  if (byHand.length > 0) {
    const labels = byHand.map((k) => structure.slots.find((s) => s.key === k)?.label ?? k);
    parts.push(`اكتب بنفسك: ${labels.join('، ')}.`);
  }
  if (reading.cut.length > 0) {
    parts.push(`قُصّت لتجاوزها الحدّ: ${reading.cut.map((c) => c.key).join('، ')}.`);
  }
  if (reading.unknown.length > 0) {
    parts.push(`أُهملت خانات لا وجود لها في هذه البنية: ${reading.unknown.join('، ')}.`);
  }
  return parts.join(' ');
}

/**
 * A MODEL'S ANSWER IS TEXT, AND TEXT IS NOT JSON UNTIL IT PARSES.
 *
 * Models wrap JSON in a fenced block, prefix it with «تفضّل:», or add a
 * closing sentence after it. All three are the same failure at the call
 * site — `JSON.parse` throws and the seller sees «تعذّر التوليد» for an
 * answer that was fine.
 *
 * So the first `{`…`}` span is taken. Not a regex over the whole text: a
 * greedy match would swallow a trailing sentence's brace and a lazy one
 * would stop at the first nested object. Braces are counted.
 */
export function parseProposal(text: string): unknown {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
