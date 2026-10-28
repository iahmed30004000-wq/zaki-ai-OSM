import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A SCREEN THAT CALLS THE API WITH A BARE `fetch` FAILS SILENTLY.
 *
 * `apiFetch` sends the person to sign in when the session has expired, and
 * to the country/store picker when the context is gone. A bare `fetch`
 * gets the 401, falls into the call site's own `.catch`, and leaves an
 * empty list on the screen — so the product says «لا يوجد» about data it
 * is simply no longer being served. It is the shape «no silent failures»
 * takes here, and it is also how a fifteen-second timeout goes missing.
 *
 * Measured across the product: 118 such calls in 43 files. They cannot all
 * be moved at once and safely — `apiFetch` THROWS on 401, so a call site
 * with no try/catch would go from an empty list to an unhandled rejection,
 * and each one has to be read.
 *
 * So this is a ratchet, not a wall. The number is written down and may
 * only go DOWN. A new bare call fails the test; paying some debt off also
 * fails it, with a message saying to lower the number — which is the only
 * way a ledger like this stays true.
 */

const root = process.cwd();

/**
 * THE ONES THAT MUST STAY BARE, AND WHY.
 *
 * `OrderDetailModal` releases its editing lock on unmount with
 * `keepalive`, so the request survives the page navigation that is
 * unmounting it. `apiFetch` would attach a 15s `AbortSignal` — which
 * defeats `keepalive` — and would redirect to /login on a 401 at the
 * worst possible moment, while a component is being torn down.
 *
 * `OrderForm` is the SELLER'S OWN PAGE, read by an anonymous shopper who
 * has no session and must never be given one. Every call it makes carries
 * `credentials: 'omit'` on purpose, and `apiFetch` would send a customer
 * who has just placed an order to OUR sign-in screen on a 401 — on a page
 * that is not ours and has no account behind it. The order submit and the
 * recommendation add-on have always been bare for this reason; they are
 * invisible to the counter below only because their URL is assembled from
 * a prop, and «the one that happens to match the regex» is not a rule.
 * The post-order offer's door is spelled out, so it is listed — under
 * `ThankYouOfferCard`, the one card every door draws (the landing form and
 * the basket's thank-you page). The call MOVED there with its reason; it
 * was not added: `OrderForm` holds none of its own now, and the count across
 * the two files is the one call it always was.
 */
/*
 * EACH EXCEPTION CARRIES ITS OWN REASON, as a string the file must still
 * contain. It used to be one literal — `keepalive: true` — checked against
 * every entry, which was correct while there was exactly one entry and
 * became a wrong test the moment there were two: the second file is bare
 * for a different reason and would have been failed for not having the
 * first one's. The point of the check is that an exception stops being
 * granted when the thing that earned it leaves the file, so the thing
 * itself is named per file.
 */
const DELIBERATE = new Map<string, { n: number; because: string }>([
  ['src/components/orders/OrderDetailModal.tsx', { n: 1, because: 'keepalive: true' }],
  ['src/components/landing/ThankYouOfferCard.tsx', { n: 1, because: "credentials: 'omit'" }],
]);

/** What is left to move, file by file. Every number here may only fall. */
const DEBT = new Map<string, number>([
  ['src/components/settings/CustomConversionsCard.tsx', 9],
  ['src/components/screens/UserDetailScreen.tsx', 8],
  ['src/components/screens/AiSettingsScreen.tsx', 6],
  ['src/components/screens/CampaignsScreen.tsx', 6],
  ['src/components/screens/PermissionsScreen.tsx', 6],
  /*
   * 6 → 5: the edit form left this screen for `ProductEditDialog`, and
   * it went through `apiJson` on the way out — so one bare `fetch` was
   * paid off rather than moved. The ratchet only ever falls.
   */
  ['src/components/screens/ProductsScreen.tsx', 5],
  ['src/components/screens/ProductDetailScreen.tsx', 5],
  ['src/components/shell/SecondFactor.tsx', 5],
  ['src/components/screens/users/UserAccessSections.tsx', 4],
  ['src/components/settings/PasskeySection.tsx', 4],
  ['src/components/landing/blocks/FontUploader.tsx', 3],
  ['src/components/screens/AssistantScreen.tsx', 3],
  ['src/components/screens/FinanceProfitScreen.tsx', 3],
  ['src/components/screens/ManufacturingScreen.tsx', 3],
  ['src/components/screens/users/CreateUserModal.tsx', 3],
  ['src/components/screens/UsersScreen.tsx', 3],
  ['src/components/settings/AdAccountsCard.tsx', 3],
  ['src/components/shell/NotificationsProvider.tsx', 3],
  ['src/components/screens/InventoryBalancesScreen.tsx', 2],
  ['src/components/screens/SystemSettingsScreen.tsx', 2],
  ['src/components/ai/AiDock.tsx', 1],
  ['src/components/labels/openWaybills.ts', 1],
  ['src/components/screens/ai/AssistantsTable.tsx', 1],
  ['src/components/screens/LandingPageDetailScreen.tsx', 1],
  ['src/components/screens/LandingPageEditorScreen.tsx', 1],
  ['src/components/screens/PerformanceScreen.tsx', 1],
  ['src/components/screens/ProfileScreen.tsx', 1],
  // The all-stores screen: everything through apiJson except the
  // context switch, which must stay a bare fetch + full navigation
  // (the selection cookie is read server-side on the next render).
  ['src/components/screens/StoresScreen.tsx', 1],
  ['src/components/screens/users/UserCommissionCurrency.tsx', 1],
  ['src/components/screens/users/UserSalary.tsx', 1],
  ['src/components/screens/users/UserShift.tsx', 1],
  /*
   * 1 → 0: the theme save went through `apiFetch`, which carries the
   * 15-second timeout. A save that never answers used to leave every
   * swatch disabled for ever.
   */
  ['src/components/settings/ThemePicker.tsx', 0],
  ['src/components/settings/TrackingPixelsSection.tsx', 1],
  ['src/components/shell/CommandPalette.tsx', 1],
  ['src/components/shell/MyWork.tsx', 1],
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, 'src', 'components'));
  walk(join(root, 'src', 'hooks'));
  return out;
}

const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Bare `fetch('/api/…')` — not `apiFetch`, not `crmApi`, not a method. */
function bareApiCalls(src: string): number {
  return [...src.matchAll(/(^|[^.\w])fetch\(\s*[`'"][^`'"]*\/api\/[^`'"]*/g)].length;
}

describe('the bare-fetch debt only goes down', () => {
  const found = new Map<string, number>();
  for (const file of sourceFiles()) {
    const n = bareApiCalls(code(readFileSync(join(root, file), 'utf8')));
    if (n > 0) found.set(file, n);
  }

  it('found call sites to count — a sweep over nothing proves nothing', () => {
    expect(sourceFiles().length).toBeGreaterThan(80);
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(50);
  });

  it('adds no new one', () => {
    const news: string[] = [];
    for (const [file, n] of found) {
      const allowed = (DEBT.get(file) ?? 0) + (DELIBERATE.get(file)?.n ?? 0);
      if (n > allowed) news.push(`${file}: ${n} > ${allowed}`);
    }
    expect(
      news,
      `نداءٌ جديدٌ بـfetch خامّ — استعمل apiFetch/apiJson:\n${news.join('\n')}`
    ).toEqual([]);
  });

  it('and the ledger says the truth about what is left', () => {
    const stale: string[] = [];
    for (const [file, n] of DEBT) {
      const now = (found.get(file) ?? 0) - (DELIBERATE.get(file)?.n ?? 0);
      if (now < n) stale.push(`${file}: صار ${now} — أنزِل الرقم من ${n}`);
    }
    expect(stale, `دَينٌ سُدِّد ولم يُسجَّل:\n${stale.join('\n')}`).toEqual([]);
  });

  it('and every deliberate exception is still deliberate', () => {
    for (const [file, { n, because }] of DELIBERATE) {
      const src = code(readFileSync(join(root, file), 'utf8'));
      expect(bareApiCalls(src), `${file}: لم يعد فيه النداءُ المقصود`).toBe(n);
      // The thing that earned the exception. If it goes, so does the reason.
      expect(src, `${file}: زال سببُ الاستثناء «${because}»`).toContain(because);
    }
  });
});
