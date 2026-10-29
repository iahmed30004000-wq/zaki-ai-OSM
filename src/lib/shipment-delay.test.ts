import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { HOLD_ADVICE_DAYS } from '@/components/ops/DelayShipmentDialog';
import { MAX_HOLD_DAYS } from '@/app/api/ops/shipments/hold/route';

/**
 * «أجّل» ASKED FOR NO DATE, AND NOTHING EVER BROUGHT THE ORDER BACK.
 *
 * Two faults, and I caused the second one myself.
 *
 *   THE HOLD HAD NO END. `until` was optional and a missing one stored the
 *   year 2999. `shipHoldUntil` is read by two files, the shipment list
 *   simply excludes anything held, and nothing anywhere announces a held
 *   order or returns it. A parcel held «for now» by somebody who then went
 *   on leave was gone — with its goods still reserved against it.
 *
 *   AND THE ROW HAD TWO BUTTONS FOR ONE THOUGHT. «أجّل» and «للمتابعة»,
 *   added in the previous batch, both read as postponing. Nobody at a
 *   packing table can decode «the first keeps the goods reserved and the
 *   confirmation standing, the second undoes both» from two labels before
 *   pressing one.
 *
 * The distinction is real and it is kept. It moved out of the button names
 * and into a sentence at the moment of choosing — which is also the only
 * place a person has the facts to choose with.
 */

const route = () => stripComments(repoFile('src/app/api/ops/shipments/hold/route.ts'));
const dialog = () => stripComments(repoFile('src/components/ops/DelayShipmentDialog.tsx'));
const screen = () => stripComments(repoFile('src/components/screens/ShipmentsNewScreen.tsx'));

describe('a hold now ends on a day', () => {
  it('the date is required, not optional', () => {
    const src = route();
    expect(src, 'الموعد ما زال اختيارياً').not.toMatch(
      /until: z\.string\(\)\.datetime\(\)\.optional\(\)/
    );
    expect(src).toMatch(/until: z\.string\(\)\.datetime\(\{ offset: true \}\)\.or\(/);
  });

  /** Storing the year 2999 is not an open-ended hold, it is a lost order. */
  it('and there is no «forever» left to fall back to', () => {
    const src = route();
    expect(src, 'ما زال يخزّن سنة ٢٩٩٩').not.toContain('2999-12-31');
    expect(src, 'ما زال يسقط إلى FOREVER').not.toMatch(/until \? new Date\(until\) : FOREVER/);
    expect(src).toContain('shipHoldUntil: new Date(until as string)');
  });

  /**
   * A release carries no date, so the two requests have two shapes. One
   * shape with everything optional accepts neither properly.
   */
  it('except the release, which is its own shape', () => {
    const src = route();
    expect(src).toMatch(/z\.union\(\[/);
    expect(src).toMatch(/release: z\.literal\(true\)/);
  });

  /** Reserved goods are goods nobody else can be sold. */
  it('and a hold cannot run for months', () => {
    const src = route();
    expect(MAX_HOLD_DAYS).toBe(30);
    expect(src, 'حارس المدّة القصوى معطَّل').toMatch(/if \(due\.getTime\(\) > maxAt\) \{/);
    expect(src).toContain('HOLD_TOO_LONG');
    // And it names the other instrument rather than just refusing.
    expect(src).toContain('أعِده إلى المتابعة');
  });

  it('nor start in the past', () => {
    expect(route()).toMatch(/due\.getTime\(\) < Date\.now\(\) - 60_000/);
  });

  /** The order comes back by itself: the list already filters on this column. */
  it('and the message says the order returns on the day, by itself', () => {
    expect(route()).toContain('ويعود إلى قائمة الشحن يومَها وحده');
    expect(stripComments(repoFile('src/app/api/ops/shipments/route.ts'))).toContain(
      'shipHoldUntil: { lte: new Date() }'
    );
  });
});

describe('and the row asks once, instead of offering two words for it', () => {
  it('has one delay control, not two', () => {
    const src = screen();
    expect(src, 'ما زال زرّ «للمتابعة» الثاني موجوداً').not.toContain('للمتابعة');
    expect(src).toContain('setDelaying(r)');
    // The cancel stays — it is a different act, and it always was.
    expect(src).toContain('setCancelling(r)');
  });

  it('and the two old handlers are gone, not merely unreachable', () => {
    const src = screen();
    expect(src, 'toggleHold ما زال في الملفّ').not.toContain('toggleHold');
    expect(src, 'postponeOrder ما زال في الملفّ').not.toContain('postponeOrder');
  });

  it('the dialog is mounted and wired to the row being delayed', () => {
    const src = screen();
    expect(src).toContain('<DelayShipmentDialog');
    expect(src, 'الحوار مرسومٌ ولا يُفتح').toMatch(/\{delaying && \(/);
  });

  /** Lifting a hold is the one half that carries no date. */
  it('and the held view still releases, without asking for one', () => {
    const src = screen();
    expect(src).toMatch(/view === 'held' \?/);
    // THE WIRING, not the name: the handler's own definition keeps the word
    // in the file however the button is gutted, and a first version of this
    // assertion passed with the onClick emptied out.
    expect(src, 'زرّ الإرجاع مفصولٌ عن معالجه').toMatch(
      /onClick=\{\(\) => void releaseHold\(r\)\}/
    );
    expect(src).toMatch(/orderId: row\.id, release: true/);
  });
});

describe('the dialog asks a date and then does ONE thing', () => {
  /**
   * THE FORK IS GONE, BY THE OWNER'S RULING.
   *
   * «ما زال الزبون يريده؟ الغيها ك خيار». The question asked a packer to
   * predict a customer's mind and then charged the shop for the guess: a
   * hopeful «yes» reserved stock for the whole postponement, decided by
   * somebody who had not spoken to anybody.
   */
  it('asks the date, and has one button that needs it', () => {
    const src = dialog();
    expect(src).toContain('إلى متى؟');
    expect(src).toMatch(/type="date"/);
    const guards = src.match(/disabled=\{!valid \|\| busy[^}]*\}/g) ?? [];
    expect(guards.length, 'عاد الخيار الثاني').toBe(1);
    expect(src, 'السؤال الملغى عاد').not.toContain('هل ما زال الزبون يريده؟');
  });

  it('and says what becomes of the goods — that they go back on sale', () => {
    const src = dialog();
    expect(src).toContain('تعود للبيع');
    expect(src).toContain('حين تُبنى الشحنة');
    expect(src).toContain('مؤجَّلة الشحن');
    expect(src, 'ما زال يَعِد بحجز البضاعة').not.toContain('وبضاعتُه محجوزةً له');
  });

  it('and the screen has one door to knock on, not two', () => {
    const src = screen();
    expect(src).toContain("'/api/ops/shipments/hold'");
    // WITH THE DATE ON IT. The dialog refuses to submit without one and the
    // route refuses a request without one — and between them sits a body
    // built by hand, where a dropped field turns every postponement into a
    // 400 that reads as «تعذّر التنفيذ».
    expect(src, 'الموعد لا يُرسَل').toContain('until: choice.until');
    expect(src, 'التأجيل ما زال يوقف الطلب أحياناً').not.toMatch(/if \(choice\.kind === 'HOLD'\) \{/);
    expect(src, 'ما زال يُلغي التأكيد في مسار التأجيل').not.toContain("outcome: 'POSTPONE'");
  });

  /**
   * The consequence of the date, before the choice — otherwise the reader
   * has to know that three weeks of reserved stock is expensive.
   */
  it('warns when the wait is long enough that reserving is the wrong answer', () => {
    const src = dialog();
    expect(HOLD_ADVICE_DAYS).toBe(7);
    expect(HOLD_ADVICE_DAYS).toBeLessThan(MAX_HOLD_DAYS);
    expect(src, 'التحذير معطَّل').toMatch(/const longWait = valid && days > HOLD_ADVICE_DAYS;/);
    expect(src).toMatch(/\{longWait && \(/);
  });

  /** The boundary must not shift under somebody mid-type. */
  it('and reads the clock once, when it opens', () => {
    const src = dialog();
    expect(src).toContain('const [openedAt] = useState(() => Date.now());');
    expect(src, 'يقرأ الساعة أثناء الرسم').not.toMatch(/> Date\.now\(\) - 60_000/);
  });
});

/**
 * AND IT DOES NOT OFFER WHAT THE DOOR WILL REFUSE.
 *
 * Measured on this database: two of the five rows the shipment list offered
 * already carried a printed waybill. `assertCancellable` refuses those, so
 * «أعِده إلى المتابعة» failed every time it was pressed on them — and a
 * control that always fails teaches people the screen is lying, which is
 * worse than a screen that offers one choice instead of two.
 *
 * The hold half stays: a printed label does not stop us keeping the parcel
 * back, only from un-confirming the sale behind it.
 */
describe('the half that cannot work is not offered', () => {
  const list = () => stripComments(repoFile('src/app/api/ops/shipments/route.ts'));

  it('the list runs the same guard the door does, not a copy of its rule', () => {
    const src = list();
    // (old → new, M6) The door asks `cancelVerdict` with the trolley's status now, and so does
    // the list — a printed waybill no longer blocks the cancel, only a trolley that was pressed.
    expect(src).toMatch(/cancelVerdict\(\{/);
    expect(src).not.toContain('assertCancellable');
    expect(src).toContain('standDownBlocked');
    // The fields that guard reads have to be selected, or it always allows.
    expect(src, 'الحارس يقرأ حقولاً غير مُحمَّلة').toContain('labelPrintedAt: true');
  });

  /**
   * AND THE VERDICT MOVED TO THE CONTROL IT ACTUALLY GOVERNS.
   *
   * It used to disable half of the postpone dialog. That half is gone, but
   * the rule it carries was always about CANCELLING: `cancelVerdict` is what the
   * stand-down door runs (since M6 it refuses a trolley that was pressed, no
   * longer a printed waybill).
   * Spending it on the postpone button left the cancel button offering
   * something the door would refuse — measured: two of five rows here
   * already had a label printed.
   */
  it('the cancel button carries it, and the postpone dialog no longer knows it', () => {
    const src = screen();
    expect(src).toContain('disabled={standingDown === r.id || !!r.standDownBlocked}');
    expect(src).toContain('title={r.standDownBlocked?.message ??');
    expect(src, 'الحوار ما زال يستقبل حكماً لا يخصّه').not.toContain('standDownBlocked={delaying.standDownBlocked}');
    expect(dialog(), 'الحوار ما زال يعرف الحكم').not.toContain('standDownBlocked');
  });

  /**
   * A printed label never stopped the postponement, and still does not —
   * what it stops is the goods going back on sale, which is a different
   * sentence and is said by `holdReservation`.
   */
  it('and a printed label does not block postponing, only releasing its goods', () => {
    const src = dialog();
    expect(src).toMatch(/onClick=\{postpone\}/);
    const hold = stripComments(repoFile('src/app/api/ops/shipments/hold/route.ts'));
    expect(hold).toContain('holdReservation(order as never)');
    expect(hold).toContain('labelPrintedAt: true');
  });
});

/**
 * THE GOODS GO BACK ON SALE — the half of the ruling that is not on screen.
 *
 * «وما تحجز رصيد الا بعد ما اشيلو من التأجيل وارجعو لانشاء شحنة». The
 * dialog can say it perfectly and the route can still freeze the stock, and
 * nobody would see the difference until a customer was refused goods that
 * were sitting on the shelf under a postponed order.
 */
describe('the hold door moves the stock as well as the date', () => {
  const hold = () => stripComments(repoFile('src/app/api/ops/shipments/hold/route.ts'));

  it('releases the lines when the shipment is postponed', () => {
    const src = hold();
    expect(src.length).toBeGreaterThan(200);
    expect(src).toMatch(/reservation\.releases\) \{\s*await releaseOrderLines\(tx, order\.id\);/);
  });

  it('and takes them again when the hold is lifted', () => {
    expect(hold()).toMatch(/if \(release\) \{[\s\S]{0,400}?await reserveOrderLines\(tx, order\.id, \{ allowNegativeStock: country\.allowNegativeStock \}\)/);
  });

  it('in one transaction, so a postponed order never keeps its reservation', () => {
    // Half of this landing is the behaviour the owner removed, wearing a
    // new label.
    expect(hold()).toMatch(/await db\.\$transaction\(async \(tx\) => \{/);
  });

  it('and the timeline records what happened to the goods', () => {
    expect(hold()).toMatch(/stock: release \? 'RESERVED_AGAIN' : reservation\.releases \? 'RELEASED' : 'KEPT'/);
  });
});
