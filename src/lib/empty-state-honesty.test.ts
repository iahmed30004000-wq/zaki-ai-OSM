import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * AN EMPTY LIST AND A HIDDEN ONE ARE NOT THE SAME SENTENCE.
 *
 * Three lists in the confirmation slice answered «there is nothing» when the
 * truth was «your search matched nothing» — which is the one sentence that
 * makes somebody stop looking:
 *
 *   /control/blacklist  — «لا أرقام محظورة.» was read off `activeCount`,
 *   which the route computes over the SEARCHED rows. Type a number nobody
 *   blocked and a screen holding a full blacklist announced that the
 *   blacklist was empty. The paragraph also short-circuited the list, so the
 *   `Rows` empty state below it — the one with a reason in it — could never
 *   render at all: two empty states, and the worse one won.
 *
 *   /confirmation/mine — both sections. «لا يوجد طلب بيدك الآن» while the
 *   heading beside it said «0 من 11», and the CONFIRMED list carried the
 *   OTHER section's copy, telling her to «اسحب طلباً من الطابور» about a
 *   list of orders she had already confirmed.
 */

describe('the blacklist', () => {
  const src = () => repoFile('src/components/screens/BlacklistScreen.tsx');

  it('has one empty state, reachable — not a paragraph shadowing the list', () => {
    const body = stripComments(src());
    // The list is always rendered; only loading short-circuits it.
    expect(body).not.toContain('لا أرقام محظورة.');
    expect(body).not.toContain('لا نتائج مطابقة.');
    expect(body).toMatch(/<Rows/);
  });

  it('says WHICH of the three things is true', () => {
    const body = src();
    expect(body).toContain('searching ? (');
    expect(body).toContain('لا نتائج مطابقة');
    expect(body).toContain('releasedHidden ? (');
    expect(body).toContain('لا حظرَ سارياً الآن');
    expect(body).toContain('لا أرقامَ محظورة');
  });

  it('and works out «searching» from the box, not from a count the server filtered', () => {
    const body = stripComments(src());
    expect(body).toContain('const searching = term.trim().length > 0');
    expect(body, 'عدٌّ محسوبٌ على نتيجة البحث').not.toContain('activeCount');
  });

  it('is a whole screen', () => {
    expect(src().length).toBeGreaterThan(2000);
  });
});

describe('«طلباتي»', () => {
  const src = () => repoFile('src/components/screens/ConfirmationMineScreen.tsx');

  it('tells a tab that is empty apart from a search that matched nothing', () => {
    const body = src();
    expect(body).toContain("findOpen.trim() ? (");
    expect(body).toContain('لا طلبَ في هذا التبويب يطابق هذا البحث');
    expect(body).toContain('لا يوجد طلب بيدك الآن');
  });

  it('and «لا يرد» says what it holds rather than borrowing «للشغل»’s words', () => {
    /*
     * The three tabs are three different jobs, so «اسحب طلباً من مركز
     * التأكيد» — which is advice about «للشغل» — would be the same fault
     * the confirmed list used to have, one tab over.
     */
    const body = src();
    expect(body).toContain('ما في طلب ما ردّ عليه حدا');
    expect(body).toContain('جرت محاولة أو محاولتان معها بلا رد');
  });

  it('gives «أكّدتها» its own words — and says WHICH day it looked in', () => {
    // 18/11: moved from ConfirmationMineScreen.tsx to confirmation/DoneList.tsx in R8c — same assertion.
    const body = repoFile('src/components/screens/confirmation/DoneList.tsx');
    expect(body).toContain('confirmed.q ? (');
    expect(body).toContain('لا طلبَ مؤكَّداً في هذا اليوم يطابق هذا البحث');
    /*
     * «لم تؤكّد طلباً بعد» was a lie the moment this list became one day:
     * she has confirmed four hundred, none of them on the day on screen.
     * The day is named in both sentences, and the way out is to change it.
     */
    expect(body).toMatch(/title=\{`لم تؤكّد طلباً في \$\{confirmed\.day\}`\}/);
    expect(body).toContain('غيِّر اليومَ أعلاه');
    // The copy that used to sit under the confirmed list belonged above it.
    expect(
      (body.match(/اسحب طلباً من الطابور/g) ?? []).length,
      'نصُّ القسم الأعلى ما زال تحت القسم الأسفل'
    ).toBeLessThanOrEqual(1);
  });

  it('offers a way out of the search it is reporting, in both kinds of tab', () => {
    const body = src();
    expect(body).toMatch(/label: 'امسح البحث', onClick: \(\) => setFindOpen\(''\)/);
    // «أكّدتها» searched the server, so clearing it has to ask again — and
    // from page one, because page nine of the old search does not exist.
    expect(body).toMatch(/setDoneQuery\(''\); setDonePage\(1\);/);
  });

  it('is a whole screen, with its actions still on it', () => {
    expect(src().length).toBeGreaterThan(2000);
    // 18/11 (R8d): the card's presses moved from ConfirmationMineScreen.tsx to confirmation/OrderCard.tsx — the screen draws it,
    // and the press's words are asked of the card (the screen's own text names them only in comments now).
    expect(src()).toContain('<OrderCard');
    expect(repoFile('src/components/screens/confirmation/OrderCard.tsx')).toContain('تأكيد الطلب');
  });
});
