import React from 'react';

/**
 * «وظيفة كل زر ومتى بضغطو؟ وشو بيعمل؟» — the owner, 8/11, on the buttons of a shipping batch.
 *
 * Eight presses on one card and a title on each that only shows on a desk, with a mouse: «إغلاق الشحنة — سُلّمت للشركة» and
 * «خرج للتوصيل لكل الدفعة (51)» say WHAT they are and nothing of WHEN, or what cannot be undone. This is the answer, one press
 * away on the card itself (a fold, so a card of forty batches is not forty paragraphs).
 *
 * It lists ONLY the presses this card has: the screen passes the same facts that decide whether each button is drawn, so the
 * help can never describe a button that is not there — and every sentence is what the code does (`PATCH /api/shipping-batches/:id`,
 * `…/out-for-delivery`, the dispatch, the paste), not what one would guess from the name.
 *
 * The first independent review of this file found four sentences that said more than the code does: a postponement after the
 * handover (the code REFUSES it; only a cancellation becomes a request), a paste the server refuses (a batch still ready at a
 * courier connected by API), «all the parcels» where a parcel can be refused and stays at «مشحون», and the list of the batch's
 * parcels with its own presses left out. Each is held in the test by what the code answers, not only by the words.
 */

export interface BatchHelpFacts {
  /** «رحّل إلى الشركة واجلب الباركود» is drawn: a courier connected by API, a batch still ready. */
  dispatch: boolean;
  /** «لصق الباركودات» is drawn. */
  paste: boolean;
  /** «إغلاق الشحنة — سُلّمت للشركة» is drawn: the batch is still ready. */
  ship: boolean;
  /** «خرج للتوصيل لكل الدفعة» is drawn, and for how many parcels still at «مشحون». */
  out: number | null;
  /** The courier is connected by API: it moves a parcel along by itself when the driver scans it. */
  courierSendsStatus: boolean;
  /** The Excel file is drawn (the address-book key is held). */
  xlsx: boolean;
  /** The list of the batch's parcels can be opened (the batch has any). */
  parcels: boolean;
  /** The batch is still an open trolley: its parcels list offers the ways off it, not only a search. */
  leave: boolean;
}

/**
 * The three ways a parcel leaves an open trolley. The screen DRAWS these buttons from this list and the help NAMES them from it,
 * so the help cannot forget one — and `LEAVE_SAYS` below is typed by the same keys, so a press without a sentence does not compile.
 */
export const LEAVE_PRESSES = [
  ['CANCEL', 'ألغِ'],
  ['FOLLOW_UP', 'أعِده للمتابعة'],
  ['HOLD', 'أجّل الشحن'],
] as const;

/** What each press does, in the words of its own confirmation dialog on the screen (`leave()`), not in a guess from the name. */
const LEAVE_SAYS: Record<(typeof LEAVE_PRESSES)[number][0], string> = {
  CANCEL: 'بيطلّع الطرد من الدفعة وبيلغي الطلب (بتكتب السبب، وإذا بوليصته مطبوعة بيسألك إذا الطرد بإيدك)',
  FOLLOW_UP: 'بيطلّع الطرد من الدفعة وبيرجّع الطلب لفريق التأكيد يكلّموا الزبون من جديد (بتحدد بعد كم يوم، من 1 لـ30)',
  HOLD: 'بيطلّع الطرد من الدفعة ويبقى الطلب مؤكَّد وبضاعته وبوليصته محفوظتين (بتحدد بعد كم يوم، من 1 لـ30)',
};

interface Item {
  key: string;
  name: string;
  when: string;
  does: string;
  undo?: string;
}

/** The sentences, built from the facts. Exported for the test, which holds them against the code's own words. */
export function batchHelpItems(f: BatchHelpFacts): Item[] {
  const items: Item[] = [];
  if (f.dispatch) {
    items.push({
      key: 'dispatch',
      name: 'رحّل إلى الشركة واجلب الباركود',
      when: 'لما الدفعة جاهزة وقبل ما تسلّمها — لشركة مربوطة بنظامها بس.',
      does: 'بيبعت طلبات الدفعة للشركة، والشركة بترجّع باركود كل طرد وبينحفظ على الطلب. والطلب اللي إله باركود من قبل بيتخطّاه (ما بينرحّل مرتين)، واللي ما انرحّل بيطلع بنتيجة الترحيل مع سببه.',
    });
  }
  if (f.paste) {
    // The server answers 409 «DISPATCH_FIRST» to a paste on a batch still ready at a courier connected by API: the dispatch brings
    // those barcodes, and a pasted one would make the dispatch skip the order. `dispatch` is the same fact that draws that press.
    items.push({
      key: 'paste',
      name: 'لصق الباركودات',
      when: f.dispatch
        ? 'مش هلّق: الدفعة لسا ما ترحّلت وشركتها مربوطة، فالنظام بيرفض اللصق — «رحّل إلى الشركة» هو اللي بيجيب الباركودات. اللصق بعد التسليم.'
        : f.courierSendsStatus
          ? 'لدفعة سُلّمت قبل ما ترحّلها: الصق باركودات إجتك من طريق تاني.'
          : 'لشركة يدوية، لما تستلم منها باركودات الطرود.',
      does: 'بتلصق «رقم الطلب, الباركود» سطر لكل طلب؛ بيتحقّق منها أول وبعدين بيكتبها على الطلبات.',
    });
  }
  items.push({
    key: 'paper',
    name: 'طباعة بوالص الدفعة · PDF · CSV' + (f.xlsx ? ' · إكسل' : ''),
    when: 'قبل التسليم.',
    does:
      'الطباعة بتطلّع بوالص كل الدفعة بجولة وحدة (والطلب اللي ما بتنطبع بوليصته بينذكر مع سببه). PDF نفس البوالص ملفاً، وحفظه ما بيعلّم الطلبات مطبوعة. CSV ملف للرفع الجماعي عند شركة بتقبله بدل الورق.' +
      (f.xlsx ? ' والإكسل بيحط كل طلبات الدفعة، بباركود الشركة أو بدونه، لإنشاء الطرود عندها يدوياً.' : ''),
  });
  items.push({
    key: 'verify',
    name: 'تحقّق من الطرود',
    when: 'قبل تسليم الدفعة.',
    does: 'بتمسح كل طرد وبيقلك إذا كان من هالدفعة.',
  });
  if (f.ship) {
    items.push({
      key: 'ship',
      name: 'إغلاق الشحنة — سُلّمت للشركة',
      when: 'لما الشركة تاخد الدفعة فعلاً.',
      does: 'الدفعة وكل طرودها بتصير «مشحون» مع وقت التسليم وسطر بسجل كل طلب. بيرفض كله ولا بيكتب شي إذا الدفعة فاضية، أو في طرد إله طلب إلغاء أو تأجيل ما انجاوب، أو طرد تغيّر لحظتها، أو في طرد بلا باركود لشركة مربوطة (بيسألك تأكّد).',
      // After the handover the code answers a cancellation with «tell the courier» (a change request) and REFUSES a postponement:
      // «الطرد سُلّم لشركة الشحن — لم يبقَ ما يُؤجَّل. اطلب الإلغاء» (`carryOut`, `change-request-intent.ts`).
      undo: 'ما بيرجع. من بعده الإلغاء بيصير طلب تغيير لازم تبلّغ فيه شركة الشحن، والتأجيل ما بيصير (الطرد صار عند الشركة) — اطلب الإلغاء.',
    });
  }
  if (f.out !== null && f.out > 0) {
    items.push({
      key: 'out',
      name: `خرج للتوصيل لكل الدفعة (${f.out})`,
      when: f.courierSendsStatus
        ? 'الشركة مربوطة بنظامها: بتحرّك كل طرد لحالها لما السائق يمسحه بالمركبة، فما بتحتاجه إلا إذا ضلت الطرود «مشحون» وانت متأكد إنو السائق طلع فيها.'
        : 'لشركة يدوية، لما السائق ياخد الدفعة ويطلع فيها — بدل ضغطة لكل طرد.',
      // Each parcel is asked what the order's own door asks (whose it is, who is editing it, confirmed, the table, a blocking
      // request): a parcel that is refused stays at «مشحون» and is named with its reason (`batch-out-for-delivery.ts`).
      does: `${f.out} = عدد طرود الدفعة اللي حالتها «مشحون» هلّق. بينقل كل طرد بيسمح طلبه بضغطة وحدة؛ واللي ما تحرّك (مثلاً مش من طلباتك، أو موظف تاني بيعدّله، أو عليه طلب تعديل ما انبتّ فيه) بينذكر بالاسم مع السبب وبيضل «مشحون». ما بيبعت شي للزبون ولا للتطبيقات ولا بيحرّك مصاري.`,
      undo: 'ما بيرجع: من «خرج للتوصيل» الطرد إما يتسلّم أو يفشل أو يرجع.',
    });
  }
  if (f.parcels) {
    items.push({
      key: 'parcels',
      name: 'طرود الدفعة',
      when: f.leave
        ? 'قبل تسليم الدفعة: لما طرد لازم يطلع منها أو يتصحّح، أو لما بدك تدوّر على طلب جواها.'
        : 'لما بدك تدوّر على طلب جوّا الدفعة.',
      does: f.leave
        ? 'بيفتح قائمة طرود الدفعة ومعها مربع بحث. على كل طرد: ' +
          LEAVE_PRESSES.map(([key, label]) => `«${label}» ${LEAVE_SAYS[key]}`).join('؛ ') +
          '. و«عدّل» (لمن معه مفتاح التعديل داخل الدفعة) بيصحّح الاسم أو الهاتف أو المحافظة أو العنوان أو كمية، وبينكتب على الطلب فوراً، وما بيغيّر سعراً ولا خصماً ولا أجرة ولا منتجاً.'
        : 'بيفتح قائمة طرود الدفعة ومعها مربع بحث. بعد التسليم القائمة للبحث بس: ما فيها إلغاء ولا تأجيل ولا تعديل.',
      undo: f.leave ? 'هالأزرار بتختفي لما تضغط «إغلاق الشحنة — سُلّمت للشركة»، وبتضل القائمة للبحث بس.' : undefined,
    });
  }
  return items;
}

export function BatchButtonsHelp({ facts }: { facts: BatchHelpFacts }) {
  const items = batchHelpItems(facts);
  return (
    <details className="pt-1">
      <summary className="cursor-pointer text-xs text-[var(--sys-muted)]">شو بيعمل كل زر ومتى بتضغطو؟</summary>
      <ul className="space-y-1 pt-1">
        {items.map((i) => (
          <li key={i.key} className="text-xs text-[var(--sys-muted-foreground)]">
            <span className="font-medium text-[var(--sys-foreground)]">{i.name}</span>
            <span className="block">متى: {i.when}</span>
            <span className="block">شو بيعمل: {i.does}</span>
            {i.undo && <span className="block">وبعدها: {i.undo}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
