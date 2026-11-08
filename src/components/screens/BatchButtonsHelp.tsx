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
}

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
      does: 'بيبعت كل طرد للشركة، والشركة بترجّع باركوده وبينحفظ على الطلب. والطرد اللي إله باركود من قبل بيتخطّاه (ما بينرحّل مرتين).',
    });
  }
  if (f.paste) {
    items.push({
      key: 'paste',
      name: 'لصق الباركودات',
      when: 'لشركة يدوية، أو لباركودات إجتك من طريق تاني.',
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
      undo: 'ما بيرجع. من بعده الإلغاء والتأجيل بيصيروا «طلب تغيير» بينبلّغ للشركة.',
    });
  }
  if (f.out !== null && f.out > 0) {
    items.push({
      key: 'out',
      name: `خرج للتوصيل لكل الدفعة (${f.out})`,
      when: f.courierSendsStatus
        ? 'الشركة مربوطة بنظامها: بتحرّك كل طرد لحالها لما السائق يمسحه بالمركبة، فما بتحتاجه إلا إذا ضلت الطرود «مشحون» وانت متأكد إنو السائق طلع فيها.'
        : 'لشركة يدوية، لما السائق ياخد الدفعة ويطلع فيها — بدل ضغطة لكل طرد.',
      does: `${f.out} = عدد طرود الدفعة اللي حالتها «مشحون» هلّق. بينقلها كلها لـ«خرج للتوصيل» بضغطة وحدة. ما بيبعت شي للزبون ولا للتطبيقات ولا بيحرّك مصاري.`,
      undo: 'ما بيرجع: من «خرج للتوصيل» الطرد إما يتسلّم أو يفشل أو يرجع.',
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
