/**
 * THE WORDS OF «تسوية السطور النظيفة عند الاعتماد» — written once, here, and SENT by the server (S8 of the brief).
 *
 * The statement screens used to say, in three places, that a statement's orders are settled when its matching closes. With the owner's
 * switch ON that is no longer the whole truth: the clean lines are settled at the approval. A sentence that is true in one mode and
 * false in the other is a lie on the screen, so the screens do not hold the new sentences at all: the list of statements carries them
 * (`settling`, only while the switch is on) and the screen shows them in place of its own. With the switch off the field is absent and
 * the screen says what it always said, to the letter.
 *
 * Server-only: nothing in `components/` imports this file, and a test holds that, so none of it is ever shipped to a browser.
 */

export interface SettlingWords {
  /** The note above the queues of a statement whose money is in and whose matching is open (matching screen). */
  moneyIn: string;
  /** The hint of the «مطابق» queue (matching screen). */
  matchedHint: string;
  /** The tooltip of «إغلاق المطابقة» (collection screen). */
  closeTitle: string;
  /** The label of the press that settles the clean lines of an approved statement; the screen adds the count. */
  button: string;
  /** What the press asks before it settles, and what it does and does not do. */
  confirmTitle: string;
  confirmBody: string;
}

export const SETTLING_WORDS: SettlingWords = {
  moneyIn:
    'المصاري دخلت المحفظة باعتماد الكشف، والطلبات المطابقة بتتسوّى معه (أو بزر «سوّي الطلبات النظيفة»). المطابقة لسا مفتوحة: ابتّ بالأسطر هون، وبعدها اضغط «إغلاق المطابقة» من «التحصيل والكشوف» — عندها بتتسوّى باقي الطلبات بلا أي حركة جديدة بالمحفظة.',
  matchedHint:
    'المبلغ في الكشف يساوي المتوقَّع — بتتسوّى هذه الطلبات وبتصير عمولتها مستحقة لحظة اعتماد الكشف، والسطر اللي لسا ما انبتّ فيه ما بيعلّق غير طلبه. كشف انعتمد قبل تشغيل المفتاح: زر «سوّي الطلبات النظيفة» بشاشة «التحصيل والكشوف».',
  closeTitle: 'إغلاق المطابقة — عندها بتتسوّى الطلبات اللي لسا ما تسوّت، بلا أي حركة جديدة بالمحفظة',
  button: 'سوّي الطلبات النظيفة هلّق',
  confirmTitle: 'تسوّي الطلبات النظيفة هلّق؟',
  confirmBody:
    'بتتسوّى بس الأسطر اللي طابقت: بتصير عمولة طلباتها مستحقة وبينسحب مخزونها. ما بتتحرك أي مصاري، والأسطر اللي بدها بتّ بتضل تنتظر هي وطلباتها. لاحقاً بتضغط «إغلاق المطابقة» لباقي الطلبات.',
};

/** What «سوّي الطلبات النظيفة هلّق» answers: how many were settled and how many were left for the close. */
export function pressMessage(e: { settled: number; heldBack: number; remaining?: number }): string {
  if (e.settled === 0 && e.heldBack === 0 && !e.remaining) return 'ما في طلبات نظيفة بتنتظر التسوية';
  const left = e.heldBack > 0 ? `، و${e.heldBack} بقوا للإغلاق (تغيّر وضعهم)` : '';
  const more = e.remaining ? `. بقي ${e.remaining} نظيف — اضغط مرة تانية` : '';
  return `تسوّى ${e.settled} طلب نظيف${left}${more}`;
}

/** What the approval says of its early step, in one sentence for the screen's toast. Empty when it had nothing to say. */
export function earlyMessage(e: { ran: boolean; settled: number; heldBack: number; failed: boolean; remaining?: number }): string {
  if (!e.ran) return '';
  if (e.failed) return 'تعذّرت تسوية الطلبات النظيفة مع الاعتماد — بتتسوّى كلها عند «إغلاق المطابقة»';
  if (e.settled === 0 && e.heldBack === 0 && !e.remaining) return '';
  const left = e.heldBack > 0 ? `، و${e.heldBack} بقوا للإغلاق (تغيّر وضعهم)` : '';
  const more = e.remaining ? `. بقي ${e.remaining} نظيف — زر «سوّي الطلبات النظيفة»` : '';
  return `تسوّى ${e.settled} طلب نظيف مع الاعتماد${left}${more}`;
}
