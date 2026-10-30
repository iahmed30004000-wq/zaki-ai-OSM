import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '../guard-source';
import {
  COURIER_FIXABLE,
  courierActionAr,
  courierActionFor,
  courierMessage,
  sealedAmong,
} from './change';
import { SEALED_FIELDS } from '../order-seal';

/**
 * ONCE THE WAYBILL IS ON THE BOX, THE PAPER IS THE ADDRESS.
 *
 * The seal says exactly that, and then the apply path handed an approved
 * change request a key straight past it: `viaRequest ? [] : sealedFieldsIn(…)`.
 * The reasoning was that a human had decided and a human deciding would have
 * rung the courier. Nothing checked that they had.
 *
 * So the ordinary case was: a supervisor approves a new address, somebody
 * presses «طبّق», our record says one street, the parcel goes to another, and
 * every screen afterwards shows an address that was never on the box.
 *
 * The approval is still the authority. What it no longer is, is a phone call.
 */

const route = () => stripComments(repoFile('src/app/api/orders/[id]/route.ts'));

describe('which message the courier gets', () => {
  /** A dispatcher edits an address on their side; the same parcel goes. */
  it('a contact change, when everything asked for is theirs to fix', () => {
    expect(courierActionFor(['customerAddress'])).toBe('CONTACT_CHANGE');
    expect(courierActionFor(['customerAddress', 'customerPhone'])).toBe('CONTACT_CHANGE');
  });

  /** Nobody opens a carton at a depot. */
  it('a cancellation and a fresh order, when anything in the box changed', () => {
    expect(courierActionFor(['quantity'])).toBe('CANCEL_AND_REORDER');
    expect(courierActionFor(['discountAmount'])).toBe('CANCEL_AND_REORDER');
  });

  /** One field out of reach is enough: a waybill cannot be half-cancelled. */
  it('and the harder one wins when the request mixes the two', () => {
    expect(courierActionFor(['customerAddress', 'quantity'])).toBe('CANCEL_AND_REORDER');
  });

  it('and nothing at all when the seal protects none of it', () => {
    expect(courierActionFor(['customerNotes'])).toBe('NONE');
    expect(courierActionFor([])).toBe('NONE');
  });

  /**
   * The two lists have to be read together: a field the seal protects and
   * nobody has classified would silently become «cancel the waybill».
   */
  it('and every field a courier can fix is one the seal protects', () => {
    for (const f of COURIER_FIXABLE) {
      if (f === 'customerCity') continue; // not sealed; harmless to list.
      expect(SEALED_FIELDS as readonly string[], `${f} ليس محميّاً بالختم`).toContain(f);
    }
  });

  it('and only the sealed fields are ever put in the message', () => {
    expect(sealedAmong(['customerAddress', 'customerNotes'])).toEqual(['customerAddress']);
  });
});

describe('the message itself', () => {
  const base = { orderNumber: 'SY-0042', storeName: 'صحة بلس', changes: { customerAddress: 'حيّ الوعر' } };

  /** Their number first: ours means nothing in their system. */
  it('leads with the tracking number the courier searches by', () => {
    const m = courierMessage({ ...base, action: 'CONTACT_CHANGE', trackingNumber: 'AR-99' });
    expect(m).toContain('بوليصة رقم AR-99');
    expect(m.indexOf('AR-99')).toBeLessThan(m.indexOf('حيّ الوعر'));
  });

  it('falling back to ours when they have not given us one', () => {
    const m = courierMessage({ ...base, action: 'CONTACT_CHANGE', trackingNumber: null });
    expect(m).toContain('طلب رقم SY-0042');
  });

  it('asks for an edit on the same waybill, not a new one', () => {
    const m = courierMessage({ ...base, action: 'CONTACT_CHANGE', trackingNumber: 'AR-99' });
    expect(m).toContain('تعديل بيانات التسليم على البوليصة نفسها');
    expect(m, 'يطلب الإلغاء في حالة التعديل البسيط').not.toContain('إلغاء هذه البوليصة');
  });

  it('and asks for a cancellation when the box itself changed', () => {
    const m = courierMessage({
      ...base,
      action: 'CANCEL_AND_REORDER',
      trackingNumber: 'AR-99',
      changes: { quantity: '3' },
    });
    expect(m).toContain('إلغاء هذه البوليصة وعدم تسليمها');
    expect(m).toContain('بوليصة جديدة');
  });

  /** Read on a phone between two calls — the field's Arabic name, not its key. */
  it('names the fields in Arabic, not in code', () => {
    const m = courierMessage({ ...base, action: 'CONTACT_CHANGE', trackingNumber: 'AR-99' });
    expect(m).toContain('العنوان: حيّ الوعر');
    expect(m, 'اسم الحقل بالإنجليزية في رسالةٍ عربيّة').not.toContain('customerAddress');
  });

  it('and every action has words for the person who has to act', () => {
    expect(courierActionAr('CONTACT_CHANGE')).toContain('على البوليصة نفسها');
    expect(courierActionAr('CANCEL_AND_REORDER')).toContain('ولا أحدَ يفتح الكرتونة');
    expect(courierActionAr('NONE')).toBe('');
  });
});

describe('and the door no longer writes before they are told', () => {
  it('the approved request stops walking past the seal on its own', () => {
    const src = route();
    expect(src, 'ما زال يتخطّى الختم بمجرّد الاعتماد').not.toMatch(
      /const sealedAsked = viaRequest \? \[\] :/
    );
    expect(src).toContain('viaRequest && courierTold ? [] :');
  });

  it('and hands back the action, the courier and the sentence to send', () => {
    const src = route();
    expect(src).toContain("code: 'COURIER_ACTION_REQUIRED'");
    expect(src).toMatch(/message: courierMessage\(\{/);
    expect(src).toMatch(/courier: provider \? \{ name: provider\.name, phone: provider\.phone \} : null/);
  });

  /** Somebody editing by hand has been through no decision at all. */
  it('while a direct edit still gets the old flat refusal', () => {
    const src = route();
    expect(src).toMatch(/if \(viaRequest\) \{[\s\S]{0,1800}code: 'ORDER_SEALED'/);
  });

  /** A fact with a name on it, not a flag. */
  it('and records who told them, once the change is written', () => {
    const src = route();
    expect(src).toMatch(/if \(stamped\.count === 1 && courierTold\) \{/);
    expect(src).toContain('أُبلغت شركة الشحن بالتعديل قبل تطبيقه');
  });

  /**
   * `courierNotified` is a statement, not a field of the order. It may ride
   * along precisely because it changes nothing about WHAT is applied.
   */
  it('and the flag may travel with a request while no order field may', () => {
    const apply = stripComments(repoFile('src/lib/change-request-apply.ts'));
    expect(apply).toContain("new Set(['changeRequestId', 'expectedVersion', 'courierNotified'])");
  });
});

/**
 * AND THE SCREEN CARRIES IT THROUGH.
 *
 * The refusal that matters here has a body — which action, which courier,
 * and the sentence to send them — and `apiJson` throws all of it away except
 * the message string. A screen reading it that way would show «الطرد عند
 * شركة الشحن» and offer nothing to do about it.
 */
describe('the screen asks, then applies', () => {
  const screen = () => stripComments(repoFile('src/components/screens/ChangeRequestsScreen.tsx'));
  const dialog = () => stripComments(repoFile('src/components/orders/CourierNotifyDialog.tsx'));

  it('reads the refusal body rather than only its message', () => {
    const src = screen();
    expect(src, 'يستعمل apiJson فيضيع جسم الرفض').toMatch(/await apiFetch\(`\/api\/orders\/\$\{r\.order\.id\}`/);
    expect(src).toMatch(/body\?\.code === 'COURIER_ACTION_REQUIRED'/);
  });

  it('and opens the message rather than an error toast', () => {
    const src = screen();
    expect(src).toContain('<CourierNotifyDialog');
    expect(src).toMatch(/\{courierFor && \(/);
  });

  /** Sending the flag on the first attempt would defeat the whole gate. */
  it('sending the flag only on the second attempt', () => {
    const src = screen();
    expect(src).toMatch(/await send\(r, false\);/);
    expect(src).toMatch(/onNotified=\{\(\) => void send\(courierFor\.request, true\)\}/);
    expect(src).toMatch(/\.\.\.\(courierNotified \? \{ courierNotified \} : \{\}\)/);
  });

  /** Opening WhatsApp is not proof; a person saying so is what is recorded. */
  it('and the dialog will not apply until somebody has sent or copied it', () => {
    const src = dialog();
    expect(src, 'يُطبَّق قبل إرسال شيء').toMatch(/disabled=\{busy \|\| !sent\}/);
    expect(src).toMatch(/setSent\(true\)/);
  });

  /**
   * ONE BUILDER, TWO CALLERS.
   *
   * There is an older guard — `contact-strip.test.ts` — that fails the build
   * when any screen writes a `wa.me` link of its own, because a screen that
   * does will normalise the number its own way. It caught this dialog, and
   * it was right to: the answer was not an exemption but somewhere for a
   * second caller to go. `whatsappLink` is now that place, and the contact
   * strip uses it too.
   */
  it('opening WhatsApp through the one shared link builder', () => {
    const src = dialog();
    expect(src).toContain("import { whatsappLink } from '@/lib/message-templates'");
    expect(src, 'الحوار يبني الرابط بنفسه').not.toMatch(/https:\/\/wa\.me\//);
    expect(src).toMatch(/whatsappLink\(phone, countryCode, ask\.message\)/);

    // And the older caller was moved onto it rather than left behind.
    const strip = stripComments(repoFile('src/components/orders/ContactButtons.tsx'));
    expect(strip, 'شريط التواصل ما زال يبني الرابط بيده').not.toMatch(/https:\/\/wa\.me\//);
    expect(strip).toMatch(/whatsappLink\(/);
  });

  /** A courier with no number on file must not be a dead end. */
  it('and a copy button for a courier with no number on file', () => {
    const src = dialog();
    expect(src).toContain('انسخ الرسالة');
    expect(src).toMatch(/disabled=\{!phone\}/);
    expect(src).toContain('لا رقم مسجَّل لشركة الشحن');
  });
});

/**
 * AND NOBODY WAITS FOR THEIR OWN PERMISSION.
 *
 * The rule the change-request door exists for is real — a confirmed order is
 * read-only for the agent, and a change passes a second pair of eyes. But
 * when the raiser IS that second pair, the queue was a supervisor approving
 * a note they had written thirty seconds earlier, on a screen they had to go
 * and open. Two conditions together, and only together: they may decide it,
 * and the parcel has not left.
 */
describe('a decider does not queue behind themselves', () => {
  const raise = () => stripComments(repoFile('src/app/api/orders/[id]/change-requests/route.ts'));
  const mine = () => stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));

  it('on both conditions, never on either alone', () => {
    // (old → new, M6 28/10) The second condition was «the waybill is not printed»
    // for every ask. For an EDIT it still is — the printed waybill fixes what the
    // driver reads. For a CANCEL or a POSTPONEMENT the line is the press of
    // «إغلاق الشحنة — سُلّمت للشركة»: a labelled parcel on our own floor can
    // still be opened, so its raiser (the owner included) need not wait for a
    // second person to approve what he can do with his own hands.
    expect(raise(), 'شرطٌ واحدٌ يكفي للبتّ الذاتي').toContain(
      "const readyToApply = mine.allowed && (intent === 'EDIT' ? !seal.sealed : !handed);"
    );
  });

  /** A decision with a name and a written reason, not a row born approved. */
  it('recorded as a decision somebody made', () => {
    const src = raise();
    expect(src).toMatch(/status: 'APPROVED',\s*decidedById: user\.id,/);
    expect(src).toContain('طُبِّق مباشرةً — رافعُه يملك البتَّ فيه');
  });

  /** An announcement about a decision already taken is noise. */
  it('and announced to nobody, because nobody is waiting', () => {
    expect(raise()).toMatch(/if \(readyToApply\) return;/);
  });

  /**
   * ONE PRESS. Making her open «بانتظار التطبيق» and press a second button
   * would be the queue we just removed, wearing a different hat — and the
   * write still goes through the one apply path, so the seal, the money
   * rules and the audit are the ones an approval would have gone through.
   */
  it('and the screen carries it through in one press', () => {
    // THE RULE, IN ITS NEW HOME. The raiser moved out of the screen when a
    // second screen needed it — the order modal, which is the only place a
    // dispatched order can be reached. What must stay true is that a
    // self-decided request is carried out in the same press, wherever the
    // press was; asserting the PATCH's presence in one screen file stopped
    // saying that the moment the code moved.
    const src = stripComments(repoFile('src/components/orders/raiseChangeRequest.ts'));
    expect(src, 'الشاشة تتجاهل أنّ الطلب جاهزٌ للتطبيق').toMatch(/if \(!res\.readyToApply\) return;/);
    expect(src).toMatch(/changeRequestId: res\.request\.id/);
    expect(src).toMatch(/method: 'PATCH'/);
  });
});

describe('and a malformed session is answered, not crashed', () => {
  /**
   * `can()` has a legacy branch whose own comment says it "should not
   * happen" — and it read `user.permissions.includes(...)` unguarded. A
   * session shaped oddly enough to reach that branch may also be missing the
   * array, and a TypeError there 500s the whole request instead of
   * answering «no». The self-decision above was the first caller to walk
   * into it.
   */
  it('a session with no permissions array is refused, not a 500', () => {
    const src = stripComments(repoFile('src/lib/authorization.ts'));
    expect(src, 'قراءةٌ غير محميّة تُسقط الطلب').not.toContain('return user.permissions.includes(permission);');
    expect(src).toContain('return (user.permissions ?? []).includes(permission);');
  });
});
