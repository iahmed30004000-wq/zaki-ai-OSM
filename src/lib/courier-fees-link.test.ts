import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { repoFile, stripComments } from './guard-source';
import { ALL_ROUTES } from './route-registry';

/**
 * A COURIER AND ITS FEES ARE ONE DECISION, AND NOW ONE SCREEN.
 *
 * `DeliveryFee` already carries `deliveryProviderId`: in the data a fee IS
 * «this courier, this region». Only the SCREENS were split, and each opened
 * with a link to the other because neither is usable alone.
 *
 * What kept them apart was the fear of one long page: fourteen regions per
 * courier, four couriers, fifty-six rows to reach one number. The answer was
 * not a page but a PANEL — the list stays a list, and a courier opens beside
 * it with its own fourteen rows. So these guards hold three things:
 *
 *   • one menu entry and one route, not two;
 *   • the fee editor knows one courier and asks for no other — a select at
 *     the top of it would be the old screen wearing a panel;
 *   • the coverage chip still says whether this courier can ship at all,
 *     because that fact is why anybody opens the panel.
 */

describe('a courier and its fees are one screen', () => {
  it('and one route: the fees screen is gone, not merely unlinked', () => {
    const paths = ALL_ROUTES.map((r) => r.path);
    expect(paths).toContain('/settings/couriers');
    expect(paths, 'أجور التوصيل ما زالت مساراً منفصلاً').not.toContain('/settings/delivery-fees');
    // A page left behind is a screen somebody still reaches by URL.
    expect(
      fs.existsSync(
        path.join(process.cwd(), 'src', 'app', '(system)', '(shell)', 'settings', 'delivery-fees')
      ),
      'صفحة الأجور المنفصلة ما زالت موجودة'
    ).toBe(false);
    expect(
      fs.existsSync(path.join(process.cwd(), 'src', 'components', 'screens', 'DeliveryFeesScreen.tsx'))
    ).toBe(false);
    // And it is in settings, where it was asked to be — not in growth.
    const group = ALL_ROUTES.find((r) => r.path === '/settings/couriers');
    expect(group?.label).toContain('وأجورها');
  });

  it('and the fee editor is given its courier rather than asking for one', () => {
    const fees = stripComments(repoFile('src/components/settings/CourierFees.tsx'));
    // The courier arrives as a prop and is used as the write key…
    expect(fees).toMatch(/courierId\s*,/);
    expect(fees).toMatch(/deliveryProviderId:\s*courierId/);
    // …and there is no courier picker: that was the duplicate question.
    expect(fees, 'محدّد شركة داخل محرّر الأجور — السؤال مكرّر').not.toMatch(
      /data\.providers\.map|<option key=\{p\.id\}/
    );
    // A different courier must not inherit the previous one's typed drafts.
    expect(fees, 'المسوّدات لا تُصفَّر عند تغيّر الشركة').toMatch(
      /setDraft\(\{\}\);[\s\S]{0,80}\}, \[courierId\]\)/
    );
  });

  it('and the courier list opens it in place, keeping the coverage fact', () => {
    const src = stripComments(repoFile('src/components/screens/CouriersScreen.tsx'));
    expect(src).toContain('<CourierFees');
    // The chip is the door now. A link would send somebody to a screen that
    // no longer exists.
    expect(src, 'ما زالت الأجور رابطاً لشاشة أخرى').not.toContain('/settings/delivery-fees');
    // The state that matters most is the one that reads as fine today:
    // a courier with no fees at all.
    expect(src, 'لا تمييز للشركة التي لا تشحن').toContain('بلا أجور');
    // Opened beside the list, so closing returns to the row that was tapped.
    expect(src).toMatch(/side="end"/);
  });

  it('and the list is told how many regions each courier is priced for', () => {
    const api = stripComments(repoFile('src/app/api/delivery-providers/route.ts'));
    expect(api, 'القائمة لا تعرف تغطية الأجور').toContain('pricedRegions');
    // The denominator too: «٨» is not an answer, «٨ من ١٢» is.
    expect(api, 'لا مقام للنسبة').toContain('totalRegions');
    // Counted for the current country, because a region belongs to one.
    expect(api).toMatch(/countryId:\s*country\.id/);
  });

  /**
   * THE BUTTON THAT SET STATE NOTHING READ.
   *
   * «الحساب والتكامل» toggled an `accountFor` id, and the credentials and
   * webhook panels were imported into this screen and rendered nowhere — so
   * the only way to give a courier its API login was to not have one. The
   * panel is where they live now, and an import with no render is exactly
   * how that came back once already.
   *
   * (The webhook panel was removed on 2/11 — the owner cancelled the webhook,
   * see `the-couriers-webhook-is-cancelled.test.ts` — so one panel is left.)
   */
  it('and the account panel is rendered, not merely imported', () => {
    const src = stripComments(repoFile('src/components/screens/CouriersScreen.tsx'));
    for (const panel of ['CourierCredentials']) {
      const rendered = new RegExp(`<${panel}\\s+providerId=`);
      expect(src, `${panel} مستورد ولا يُعرَض`).toMatch(rendered);
    }
  });
});
