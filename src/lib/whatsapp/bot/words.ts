/**
 * READING THE CUSTOMER'S OWN WORDS FOR THE DECISIONS THE BOT MAY NEVER GUESS — pure, so each rule is tested on its own.
 *
 * Ported from the landing confirmation chat (Zaki pages, `chat-words.ts`): the model PROPOSES a confirmation, and this code
 * decides whether the customer's latest message really is a clear yes. A «يمكن», a «بعدين», a yes followed by «بس…» is not.
 */

/** Arabic folded for matching: no diacritics or tatweel, one alef, ى→ي, ة→ه, punctuation to spaces. */
export const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ـ/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const AMBIGUOUS = /(^| )(يمكن|ممكن|بلكي|بفكر|خليني فكر|خليني افكر|رح فكر|بعدين|ان شاء الله|انشالله|انشاءالله|ان شالله|مش متاكد|مو متاكد|مانا متاكد|لسا|منشوف|بشوف|رح شوف|مدري|ما بعرف)( |$)/;
const BUT = /(^| )(بس|لكن|بدي غير|غير|عدل|عدلي|بدي بدل)( |$)/;
const NO = /(^| )(لا|لأ|لاء|مو|مش|ما بدي|مابدي)( |$)/;
const YES = /(^| )(اي|ايه|ايوه|ايوا|اكيد|نعم|تمام|موافق|موافقه|اكد|اكدو|اكدولي|اكدلي|اكديه|ابعت|ابعتو|ابعتوه|ابعتيه|ماشي|يلا|اوكي|اوك|ok|okay|yes|صح|صحيح|مزبوط|ثبت|ثبتو|ثبتي)( |$)/;

/** A clear yes to the confirmation question: no hedge, no «but», no no. */
export function explicitYes(text: string): boolean {
  const t = norm(text);
  return !!t && YES.test(t) && !AMBIGUOUS.test(t) && !BUT.test(t) && !NO.test(t);
}

/** The words the model quotes must really be in what the customer wrote. */
export function said(customerText: string, words: string): boolean {
  const w = norm(words);
  return !!w && norm(customerText).includes(w);
}

/** Whether a reply states this amount (Arabic or Latin digits, any thousands separator). */
export function mentionsAmount(text: string, amount: number): boolean {
  const latin = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
  return (latin.match(/\d[\d,]*(\.\d+)?/g) ?? []).some((n) => Math.abs(Number(n.replace(/,/g, '')) - amount) < 0.001);
}

/** What the model wrote, made fit for WhatsApp: no reasoning block, no button markup, at most Meta's 4096 characters. */
export function cleanReply(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/\[\[[^\]]*\]\]\s*$/g, '')
    .trim()
    .slice(0, 4096);
}
