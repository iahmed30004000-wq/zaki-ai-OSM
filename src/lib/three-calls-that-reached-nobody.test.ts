import { describe, expect, it } from 'vitest';
import { CONTACT_RESULTS, NO_ANSWER_LIMIT, NO_ANSWER_RESULTS } from './confirmation-workflow';
import { CONTACT_FIRST_ACTIONS, needsContactFirst } from './confirmation-queue';
import { repoFile, stripComments } from './guard-source';
import { cardTone, noAnswerWords } from './no-answer-tone';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PHONE THAT CANNOT RING, AND THE DOOR THAT WAS LEFT OPEN.
 *
 * Two things the owner watched an agent hit.
 *
 * ── A PHONE THAT IS OFF HAD NO WORD ──
 *
 * She rings, hears the network's own recording, and has to file it as
 * `NO_ANSWER` — which says the customer did not pick up, a different fact
 * about a different person. The two read the same in a counter and
 * differently to whoever opens the order next: one is somebody ignoring
 * the phone, the other is what a wrong digit looks like.
 *
 * ── AND THE COUNTER AND THE CLOSE DISAGREED ──
 *
 * The counter read `['NO_ANSWER', 'BUSY']` and the close fired only on
 * `NO_ANSWER`. So an order whose third attempt was busy reached «3/3» and
 * closed nothing, and sat there with no door out of it. One list now.
 *
 * ── AND «افتح وعدّل» WAS THE WAY AROUND THE OTHER THREE ──
 *
 * «تأكيد» and «تأجيل» and «ألغِ» have been locked until the order carries
 * a contact attempt since C1. «افتح وعدّل» was not — so an agent who had
 * rung nobody could open the order, change the quantity, the price or the
 * address, and save. The rule existed and its widest door was open.
 * ═══════════════════════════════════════════════════════════════════════
 */

describe('a call that reached nobody', () => {
  it('has a word of its own', () => {
    expect(CONTACT_RESULTS).toContain('UNREACHABLE');
  });

  it('and counts toward the three, like the other two ways a line fails', () => {
    expect([...NO_ANSWER_RESULTS].sort()).toEqual(['BUSY', 'NO_ANSWER', 'UNREACHABLE']);
  });

  it('and «answered» and «message sent» are not among them', () => {
    // A sent message is an attempt — it unlocks the four actions — but it
    // is not a call that reached nobody, and counting it would close an
    // order because somebody tried twice more.
    for (const not of ['ANSWERED', 'MESSAGE_SENT', 'WRONG_NUMBER', 'OPENED', 'CALLBACK_REQUESTED']) {
      expect(NO_ANSWER_RESULTS as readonly string[], not).not.toContain(not);
    }
  });

  it('and the limit is still three', () => {
    expect(NO_ANSWER_LIMIT).toBe(3);
  });
});

describe('the counter and the close read ONE list', () => {
  const route = () => stripComments(repoFile('src/app/api/orders/[id]/contact-attempts/route.ts'));

  it('— the counter does', () => {
    const src = route();
    expect(src, 'العدّاد لسّا بلستة مكتوبة بالإيد').not.toMatch(/result:\s*\{\s*in:\s*\['NO_ANSWER'/);
    expect(src).toContain('NO_ANSWER_RESULTS');
  });

  it('— and so does the close, so a third BUSY is not a dead end', () => {
    /*
     * This was the bug: `result === 'NO_ANSWER'` alone. The counter had
     * always counted BUSY, so the order reached the limit and then nothing
     * closed it.
     */
    const src = route();
    expect(src, 'الإغلاق لسّا بيفحص NO_ANSWER وحدها').not.toMatch(/result === 'NO_ANSWER' &&/);
    expect(src).toMatch(/NO_ANSWER_RESULTS[\s\S]{0,80}includes\(result/);
  });

  it('and the mine screen counts the same three', () => {
    const src = stripComments(repoFile('src/app/api/confirmation/mine/route.ts'));
    expect(src, 'شاشة «طلباتي» بتعدّ لستة تانية').toContain('NO_ANSWER_RESULTS');
  });
});

describe('«افتح وعدّل» joined the rule', () => {
  it('is one of the actions that wait for a contact attempt', () => {
    expect(CONTACT_FIRST_ACTIONS as readonly string[]).toContain('edit');
  });

  it('and the holder with no attempt is refused', () => {
    expect(needsContactFirst({ action: 'edit', isHolder: true, hasAttempt: false })).toBe(true);
  });

  it('and one attempt — «رقم خطأ» included — unlocks it', () => {
    // «رقم خطأ» is an attempt, and it is the finding that most often makes
    // an edit the right next move.
    expect(needsContactFirst({ action: 'edit', isHolder: true, hasAttempt: true })).toBe(false);
  });

  it('and it binds the holder, never a supervisor correcting a record', () => {
    expect(needsContactFirst({ action: 'edit', isHolder: false, hasAttempt: false })).toBe(false);
  });

  it('and the server refuses it, not only the card', () => {
    /*
     * A card that hides a button is a courtesy. The rule is the door: the
     * order route refuses a holder's edit of a customer or line field
     * before any attempt, with the code the screen reads.
     */
    const src = stripComments(repoFile('src/app/api/orders/[id]/route.ts'));
    expect(src, 'الباب ما بيفحص القاعدة').toContain("code: 'CONTACT_FIRST'");
    expect(src).toContain("needsContactFirst({ action: 'edit'");
  });

  it('and the card no longer claims the edit button is open', () => {
    // The comment on the screen used to name «افتح وعدّل» among the ones
    // that stay available. A stale sentence beside a changed rule is how
    // the next person restores the bug.
    const screen = repoFile('src/components/screens/ConfirmationMineScreen.tsx');
    expect(screen).not.toMatch(/«افتح وعدّل», «إدخال إشكال» and «مساعدة» stay open/);
  });
});

describe('and the card says where the order came from', () => {
  const screen = () => stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));

  it('because an entry issue goes to the moderator who typed it', () => {
    expect(screen()).toContain('sourceLabel(order)');
  });

  it('and «إدخال إشكال» is drawn only on an order a moderator entered', () => {
    /*
     * The door accepts `moderatorId` orders only; a store order is refused
     * with «لا يمكن فتح إشكال إدخال على طلب من مصدر خارجي». Drawn on every
     * card, the agent learned that by pressing it — and pressed it again
     * on the next one.
     */
    const src = screen();
    const at = src.indexOf('إدخال إشكال');
    expect(src.slice(Math.max(0, at - 300), at), 'الزرّ مرسوم على كلّ كرت').toContain('order.moderatorId');
  });

  it('and a store order says what to do instead, not nothing', () => {
    const src = screen();
    expect(src).toContain('ما في مودريتور يصلّحه');
    expect(src, 'بيقول المشكلة وما بيقول الحلّ').toContain('سجّل «رقم خطأ»');
  });

  it('and the API sends the four fields the sentence needs', () => {
    const src = stripComments(repoFile('src/app/api/confirmation/mine/route.ts'));
    for (const field of ['source:', 'moderatorId:', 'createdBy:', 'channel:']) {
      expect(src, `«طلباتي» ما بتبعت ${field}`).toContain(field);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AND THE ONE LIST HELD THREE DIFFERENT JOBS.
 *
 * «طلباتي» was two sections: everything workable in one, and the last
 * hundred she ever confirmed under it. Both halves mixed things she must
 * act on with things she must not.
 *
 * An order nobody has reached is a CALL. An order rung twice with nothing
 * is a DECISION — one more and it closes itself. An order the third call
 * closed is neither; it is a fact she needs to see once. And the
 * confirmed list was `take: 100` by date: the agent who has confirmed a
 * thousand orders cannot reach Tuesday's from there, and the search box
 * on top of it searched only those hundred — so it answered «لا شيء
 * يطابق» about a list it had never looked in.
 * ═══════════════════════════════════════════════════════════════════════
 */

describe('«طلباتي» in three tabs', () => {
  const route = () => stripComments(repoFile('src/app/api/confirmation/mine/route.ts'));

  it('and the server decides which tab an order is in, not the browser', () => {
    /*
     * Two places that each decide this eventually disagree, and then the
     * count on the tab differs from the list under it. The split is one
     * pass over the rows, by the count the row already carries.
     */
    const src = route();
    expect(src, 'ما في تبويب «اتصلي هلّق» بالباب').toMatch(/work:\s*held\.filter/);
    expect(src, 'ما في تبويب «بانتظار» بالباب').toMatch(/noAnswer:\s*held\.filter/);
    expect(src).toContain('closedToday:');
  });

  it('and «بانتظار» is made by the verdict (8/11) — an open order past the limit stays in it, never on no list', () => {
    // The third is not work. It is a cancelled order, and it is below.
    const src = route();
    const at = src.indexOf('noAnswer: held.filter');
    // The tab was decided here by the count alone; the verdict decides it now (`deskTab`, `work-first.ts`, tested on its own) and the
    // count only settles what the verdict leaves open — one or two, or an open order past the limit, are in «بانتظار».
    expect(src.slice(at, at + 160)).toMatch(/noAnswer: held\.filter\(\(o\) => tabOf\(o\) === 'noAnswer'\)/);
    expect(src).toMatch(/const tabOf = [^\n]*deskTab\(/);
    const rule = stripComments(repoFile('src/lib/work-first.ts'));
    expect(rule, 'an open order past the limit must stay in «بانتظار»').toContain("return noAnswerCount > 0 ? 'noAnswer' : 'work';");
  });

  it('and the third’s closure is found by its log entry, not by updatedAt', () => {
    /*
     * `updatedAt` moves with any later write, so a note added tomorrow
     * would make a Tuesday closure look like it happened today.
     */
    const src = route();
    expect(src).toContain('AUTO_CLOSE_NO_ANSWER_3_ATTEMPTS');
    expect(src).toContain("rejectionReason: 'NO_ANSWER_3_ATTEMPTS'");
  });

  it('and «أكّدتها» is a day, a search and a page — all three on the server', () => {
    const src = route();
    expect(src, 'ما في يوم').toContain("params.get('day')");
    expect(src, 'ما في بحث').toContain("params.get('q')");
    /*
     * Through the SHARED reader, not `Number(params.get('page'))`: that
     * is how `?page=abc` becomes NaN and `?page=1e400` puts a value past
     * Int into `skip`. `a-page-number-is-not-a-crash.test.ts` holds the
     * rule for every paged door; this names it for this one.
     */
    expect(src, 'ما في صفحة').toContain('readPage(params)');
    expect(src, 'الصفحة بتنقص بالمتصفّح لا بالباب').toMatch(/skip:\s*\(page - 1\) \* CONFIRMED_PAGE_SIZE/);
    expect(src).toMatch(/take:\s*CONFIRMED_PAGE_SIZE/);
    expect(src, 'العدد الكلّي ما بينرجع — فالصفحات بتصير ممرّاً بلا آخر').toContain('confirmedTotal');
  });

  it('and a mistyped day falls back to today rather than to nothing', () => {
    // The one thing this list must never do is come back empty because a
    // query string was mistyped.
    expect(route()).toMatch(/const day = dayStart && dayEnd \? dayAsked : localDayKey\(now\)/);
  });

  it('and «اليوم» means the same thing here as it does on the dashboard', () => {
    /*
     * `startOfLocalDay` and `endOfLocalDay` were private to analytics.ts.
     * A second copy of a date boundary is how two screens come to
     * disagree about when a day begins — three hours of every Amman
     * evening, in which an order belongs to yesterday on one and today on
     * the other.
     */
    expect(route()).toContain("from '@/lib/local-day'");
    expect(stripComments(repoFile('src/lib/analytics.ts')), 'التحليلات لسّا عندها نسختها').toContain(
      "from './local-day'"
    );
  });

  it('and the search runs on the three things a customer reads out', () => {
    const src = route();
    const at = src.indexOf('const search =');
    const block = src.slice(at, at + 700);
    expect(block).toContain('orderNumber');
    expect(block).toContain('fullName');
    expect(block, 'الهاتف بينتبحث بشكله لا بأرقامه').toContain('rawPhone');
    expect(block).toContain('digits');
  });
});

describe('and the card says the count, not only the colour', () => {
  it('— one and two have words of their own', () => {
    expect(noAnswerWords(1)).toBe('ما ردّ مرّة واحدة');
    expect(noAnswerWords(2)).toBe('ما ردّ مرّتين');
  });

  it('and the tone moves with the count, calm at zero', () => {
    expect(cardTone(0, 3)).toContain('--sys-card');
    expect(cardTone(1, 3), 'المحاولة الأولى بلا لون').toContain('--sys-warning');
    expect(cardTone(2, 3), 'المحاولتان بنفس قوّة الواحدة').not.toBe(cardTone(1, 3));
  });

  it('and a closed one is the red that means «money lost», not amber', () => {
    expect(cardTone(3, 3, true)).toContain('--sys-destructive');
  });

  it('and no theme invents a hue for this — the meanings are fixed', () => {
    /*
     * A theme moves SURFACES, never MEANINGS: amber is «needs attention»
     * and red is «late or money lost», product-wide. «لا يرد» uses amber
     * at two strengths rather than a third colour, so a theme that
     * recolours the product cannot make two no-answers read as green.
     */
    for (const tone of [cardTone(1, 3), cardTone(2, 3), cardTone(3, 3, true)]) {
      expect(tone, 'لون مكتوب بالإيد جوّا الكرت').toMatch(/^(bg|border)-\[var\(--sys-/);
      expect(tone).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });

  it('and the screen draws three tabs, each with its count', () => {
    const screen = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    expect(screen).toContain('role="tablist"');
    for (const label of ['اتصلي هلّق', 'بانتظار', 'أكّدتها']) {
      expect(screen, `ما في تبويب «${label}»`).toContain(`label="${label}"`);
    }
    expect(screen, 'التبويب بلا عدد — والقرار بينعمل قبل ما تفتحه').toMatch(/count=\{data\.work\.length\}/);
  });

  it('and a closed card carries no footer of greyed buttons', () => {
    // A row of disabled buttons reads as «try again in a minute». The
    // order is cancelled; what is left to do about it is somewhere else.
    const screen = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    expect(screen).toMatch(/\{closed \? \(/);
    expect(screen).toContain('للقراءة فقط');
  });
});
