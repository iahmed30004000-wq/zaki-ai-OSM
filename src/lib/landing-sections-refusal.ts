import type { ZodError } from 'zod';
import { SECTION_LABEL, type SectionType } from './landing-sections';
import { zodMessage } from './zod-message';

/**
 * THE SENTENCE A REFUSED SAVE SAYS — which section, which field, what is wrong.
 *
 * The editor's save answered every rejected page with «أقسام الصفحة غير صالحة», however many sections the page had
 * and whichever of its fields had gone over its limit: the seller scrolled a forty-section page looking for the one
 * headline that was ten characters too long. The first thing zod found is named here, in the words the seller sees
 * on the screen (`SECTION_LABEL`, the same names as the section list), with the position so two sections of one kind
 * can be told apart.
 *
 * The field names are the ones a seller reads on a section's card; a field with no name here is still reported — by
 * the section — rather than guessed at.
 */
const FIELD_AR: Record<string, string> = {
  headline: 'العنوان',
  subheadline: 'العنوان الفرعي',
  title: 'العنوان',
  text: 'النص',
  body: 'النص',
  ctaText: 'نص الزر',
  image: 'الصورة',
  images: 'الصور',
  items: 'البنود',
  q: 'السؤال',
  a: 'الجواب',
  ask: 'السؤال',
  options: 'الخيارات',
  doubt: 'الاعتراض',
  answer: 'الجواب',
  when: 'الموعد',
  what: 'الوصف',
  aspect: 'وجه المقارنة',
  ours: 'منتجنا',
  theirs: 'البدائل',
  oursLabel: 'عنوان عمود منتجنا',
  theirsLabel: 'عنوان عمود البدائل',
};

const ARABIC = /[؀-ۿ]/;

/** The deepest named key of a path below the section: `items.2.text` → `text`. */
function fieldOf(path: PropertyKey[]): string | null {
  for (let i = path.length - 1; i >= 1; i--) {
    const key = path[i];
    if (typeof key === 'string') return key;
  }
  return null;
}

export function sectionsRefusal(error: ZodError, input: unknown): string {
  const issue = error.issues[0];
  if (!issue) return 'أقسام الصفحة غير صالحة';

  // The page holds more sections than it may: nothing to point at but the count.
  if (issue.path.length === 0) {
    const max = (issue as { maximum?: number | bigint }).maximum;
    return issue.code === 'too_big' && typeof max !== 'undefined'
      ? `أقسام الصفحة أكثر من المسموح: ${max} على الأكثر`
      : 'أقسام الصفحة غير صالحة';
  }

  const index = issue.path[0];
  const section = typeof index === 'number' && Array.isArray(input) ? (input[index] as { type?: unknown } | undefined) : undefined;
  const label = section && typeof section.type === 'string' ? SECTION_LABEL[section.type as SectionType] : undefined;
  if (!label || typeof index !== 'number') return 'أقسام الصفحة غير صالحة';

  const field = fieldOf(issue.path);
  const fieldName = field ? FIELD_AR[field] : undefined;
  // Zod's own English is never shown: only an Arabic sentence (ours or a limit zodMessage composes) is passed on.
  const said = zodMessage(error);
  const detail = ARABIC.test(said) ? said : 'قيمة غير صالحة';
  return `${label} (القسم ${index + 1})${fieldName ? ` — ${fieldName}` : ''}: ${detail}`;
}
