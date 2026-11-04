import { describe, expect, it } from 'vitest';
import { CONTACT_RESULTS } from './confirmation-workflow';
import { dashboardFiles, repoFile, stripComments } from './guard-source';

/**
 * REACHING A CUSTOMER, FROM THE SCREEN WHOSE WHOLE JOB IS REACHING THEM.
 *
 * «طلباتي» had two hand-rolled buttons and both were poorer for it. The
 * WhatsApp one opened NOTHING — it recorded a contact and left the agent to
 * find the customer in WhatsApp themselves — and there was no SMS at all, on
 * the one screen where the work is making contact.
 *
 * `ContactButtons` already carried the ready-made messages, filtered by
 * channel and filled with the order's own words, and two other screens
 * already used it. The templates were never missing; this screen was not
 * asking for them.
 */

describe('the contact strip', () => {
  it('is the shared one, on the screen that needs it most', () => {
    const screen = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    expect(screen, 'شاشة «طلباتي» لا تستعمل شريط الاتصال المشترك').toContain('<ContactButtons');
    // And the hand-rolled pair is gone, not left beside it.
    expect(screen, 'ما زال فيها زرُّ واتساب مكتوبٌ باليد').not.toMatch(
      /logAttempt\(order, 'WHATSAPP', 'ANSWERED'\)/
    );
    expect(screen, 'ما زال فيها اتّصالٌ مكتوبٌ باليد').not.toContain('const callCustomer');
  });

  it('and carries this order’s own words into the message', () => {
    const screen = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    const call = screen.slice(screen.indexOf('<ContactButtons'), screen.indexOf('/>', screen.indexOf('<ContactButtons')));
    for (const field of ['orderNumber', 'customerName', 'amount']) {
      expect(call, `القالب بلا ${field}`).toContain(field);
    }
  });

  /**
   * A SENT MESSAGE IS NOT AN ANSWER.
   *
   * Filing it as `ANSWERED` would inflate the answer rate — the number that
   * decides whether the problem is the script or the hour of the day — with
   * messages nobody has replied to. So it has its own result.
   */
  it('records a press as a press, never as an answer', () => {
    /*
     * AND A DIALLED CALL IS NOT AN ANSWER EITHER.
     *
     * This screen used to file one as `ANSWERED` — the strongest outcome
     * there is — because it had nothing weaker to say, so the answer rate
     * counted every dial as a conversation. That is the same inflation the
     * note above warns about for messages, and it was two lines below it.
     *
     * `OPENED` says what the browser actually knows: the dialler was
     * opened on this number, by this employee, now. Counted toward
     * neither the answer rate nor the three-strike close.
     *
     * Where the press is RECORDED is no longer this screen's business —
     * `ContactButtons` does it for every screen, and
     * `a-press-leaves-a-line.test.tsx` presses the buttons and reads what
     * was sent. What is held here is that no screen files a press as an
     * outcome.
     */
    expect(CONTACT_RESULTS).toContain('MESSAGE_SENT');
    expect(CONTACT_RESULTS, 'ما في نتيجة للكبسة نفسها').toContain('OPENED');

    for (const { rel, src } of dashboardFiles()) {
      const body = stripComments(src);
      if (!body.includes('ContactButtons')) continue;
      expect(body, `${rel}: الكبسة بتنسجّل نتيجةَ اتصال`).not.toMatch(
        /onContacted[\s\S]{0,200}'ANSWERED'/
      );
    }
  });

  /**
   * AND IT NEVER COUNTS TOWARD THE THREE-STRIKE CLOSE.
   *
   * That counter reads NO_ANSWER and BUSY. Closing an order because three
   * messages were sent would punish the agent for trying twice more.
   */
  it('and a sent message never closes an order', () => {
    const route = stripComments(repoFile('src/app/api/orders/[id]/contact-attempts/route.ts'));
    const counted = /result: \{ in: \[([^\]]*)\] \}/.exec(route);
    expect(counted, 'لا عدّاد محاولات').toBeTruthy();
    expect(counted![1], 'الرسالة المُرسَلة تُحسب محاولةً بلا ردّ').not.toContain('MESSAGE_SENT');
  });

  /**
   * THE STRIP RECORDS ITS OWN PRESSES, SO NO SCREEN HAS TO REMEMBER.
   *
   * It used to report to its caller and leave the recording to them, and
   * exactly one of the four screens that show a customer's number passed
   * anything. Three doors — the dial, the template send, the empty
   * WhatsApp — now go through one function that writes the line.
   */
  it('records its own presses, through one door', () => {
    const src = stripComments(repoFile('src/components/orders/ContactButtons.tsx'));
    // The door is written once, in the line's own module, which sends it first and keeps it until it lands (4/11).
    expect(src, 'الشريط ما بيسجّل لحاله').toContain('sendContactLine(');
    expect(stripComments(repoFile('src/lib/contact-line.ts'))).toContain('contact-attempts');
    expect((src.match(/noteContact\(/g) ?? []).length, 'في باب ما بيمرّ على المسجّل').toBe(3);
  });

  /**
   * AND EVERY SCREEN THAT SHOWS A CUSTOMER'S NUMBER OFFERS IT.
   *
   * The orders list printed the number as plain text with nothing to press,
   * the order window the same, and the customers screen had a bare `tel:`
   * and no WhatsApp at all. So the agent read the digits off the screen and
   * typed them into a phone, with the transposed digit that goes with that.
   */
  it('and is on every screen that shows a customer’s number', () => {
    for (const rel of [
      'src/components/screens/OrdersScreen.tsx',
      'src/components/screens/CustomersScreen.tsx',
      'src/components/screens/ConfirmationMineScreen.tsx',
      'src/components/screens/TrackingScreen.tsx',
      'src/components/orders/CustomerCard.tsx',
    ]) {
      expect(stripComments(repoFile(rel)), `${rel}: الرقم معروض بلا شي تكبسه`).toContain(
        'ContactButtons'
      );
    }
  });

  /**
   * AND THE ORDER ONES PASS THE ORDER, OR THE LINE IS NEVER WRITTEN.
   *
   * `orderId` is what the strip files the press against; without it the
   * press opens the dialler and records nothing. The customers screen is
   * the deliberate exception — a row there is a person, not a parcel.
   */
  it('and the screens that have an order pass it', () => {
    for (const rel of [
      'src/components/screens/OrdersScreen.tsx',
      'src/components/screens/ConfirmationMineScreen.tsx',
      'src/components/orders/CustomerCard.tsx',
    ]) {
      const body = stripComments(repoFile(rel));
      // The whole element, not a fixed window: one of these call sites
      // carries a paragraph of its own explaining why the press is not an
      // outcome, and a window wide enough for it would reach the next
      // component on another screen.
      const from = body.indexOf('<ContactButtons');
      const call = body.slice(from, body.indexOf('/>', from));
      expect(call, `${rel}: الشريط بلا رقم طلب — فالكبسة ما بتنسجّل`).toContain('orderId');
    }
  });

  /**
   * AND THE NUMBER TRAVELS IN FULL INTERNATIONAL FORM.
   *
   * `wa.me` takes digits with the country code and nothing else. A link
   * built from a local `079…` opens a chat with a number that does not
   * exist, which to the person pressing looks like WhatsApp being broken.
   * The country is known on the server and nowhere in the browser, so each
   * list sends its dial code.
   */
  it('and every list sends the country’s calling code', () => {
    for (const rel of [
      'src/app/api/orders/route.ts',
      'src/app/api/orders/[id]/route.ts',
      'src/app/api/customers/route.ts',
      'src/app/api/ops/tracking/route.ts',
    ]) {
      expect(stripComments(repoFile(rel)), `${rel}: القائمة بلا رمز اتّصال`).toMatch(
        /dialCode:\s*ruleFor\(/
      );
    }
  });

  /**
   * AND NO SCREEN BUILDS ITS OWN.
   *
   * A `sms:` or `wa.me` link written into a screen is a screen that will not
   * have the templates, will not report the contact, and will not know that
   * a desktop browser cannot send an SMS.
   */
  it('and no screen hand-writes a message link of its own', () => {
    const offenders: string[] = [];
    for (const { rel, src } of dashboardFiles()) {
      if (rel.endsWith('/ContactButtons.tsx')) continue;
      const body = stripComments(src);
      if (/`sms:\$\{/.test(body) || /wa\.me\//.test(body)) offenders.push(rel);
    }
    expect(offenders, `رابط رسالة مكتوب في شاشة:\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * AND THE OTHER DIRECTION HAS ONE PLACE TOO.
   *
   * A shopper tapping «واتساب» in a shop's header is not this rule: they
   * have no order, no session and nothing to record an attempt against —
   * which is every input `ContactButtons` needs. So it has its own owner,
   * `store-contact.ts`, held to the same one-place discipline: the link
   * is digits only with the leading + stripped, and one built from
   * «+963 11 222 3333» as typed opens nothing. To a shopper that looks
   * exactly like a shop that does not answer.
   *
   * The rule above already catches a public page that builds one, because
   * `wa.me/` is in its pattern. This is the anchor under it — the owner
   * must still build one, or that rule is being satisfied by a feature
   * nobody has.
   */
  it('and the shop’s own WhatsApp link is built, in its own place', () => {
    expect(stripComments(repoFile('src/lib/store-contact.ts'))).toContain('wa.me/');
    expect(stripComments(repoFile('src/components/storefront/StorefrontShell.tsx')))
      .toContain('whatsappHref(store.supportPhone)');
  });
});
