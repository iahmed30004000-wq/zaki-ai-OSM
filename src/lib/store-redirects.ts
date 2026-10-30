import { z } from 'zod';
import { db } from './db';
import { omittedMeansOmitted } from './zod-patch';

/**
 * OLD ADDRESSES THAT STILL ARRIVE.
 *
 * A seller renames a landing page's slug while an advertisement is running
 * on the old one. Every click on that ad — already paid for — lands on a
 * 404. The money is spent either way; the only question is whether the
 * customer reaches the page.
 *
 * So a rename SUGGESTS a redirect, automatically, and the seller accepts or
 * dismisses it. It is a suggestion and not an act, because only the seller
 * knows whether the old address should keep working or should stop: a slug
 * changed to get away from a campaign is a slug that must NOT forward.
 *
 * 301 means "this moved for good" and browsers and search engines cache it,
 * sometimes for a very long time. 302 means "for now". The default is 302,
 * because a 301 the seller did not mean is close to unrecoverable on the
 * machines that cached it.
 */

export const REDIRECT_KINDS = [301, 302] as const;
export type RedirectKind = (typeof REDIRECT_KINDS)[number];

/**
 * A path this app serves, as a redirect's source.
 *
 * One leading slash and no second one: `//evil.example` is a path to a
 * regex and another origin to a browser. No query and no fragment either —
 * the match is on the path, and a `from` carrying `?c=ad1` would silently
 * never match anything.
 */
/**
 * ARABIC IS A PATH TOO.
 *
 * This was `[A-Za-z0-9/_.-]` — Latin only — so a seller whose shop is
 * written in Arabic could not redirect any address their shop actually
 * has. It also made «تغيير رابط منتج بيولّد إعادة توجيه تلقائية»
 * impossible to honour even by hand.
 *
 * The letters are added; nothing is loosened. A backslash, whitespace,
 * a query and a fragment are still out, and the leading `//` that would
 * make a path into a protocol-relative URL is still refused — that one
 * is what turns a redirect into an open door to another host.
 */
export const REDIRECT_FROM =
  /^\/(?![/\\])[\u0621-\u063A\u0641-\u064AA-Za-z0-9/_.\-]{0,200}$/;

/** Where a redirect may send somebody: a path here, or an absolute http(s) URL. */
export const REDIRECT_TO = /^(\/(?![/\\])[^\s?#]*|https?:\/\/[^\s]+)$/;

export const redirectCreateSchema = z.object({
  from: z.string().trim().max(200).regex(REDIRECT_FROM, 'المسار القديم: يبدأ بشرطة مائلة واحدة، بلا علامة استفهام'),
  to: z.string().trim().min(1).max(300).regex(REDIRECT_TO, 'المسار الجديد غير صالح'),
  kind: z.union([z.literal(301), z.literal(302)]).default(302),
  isActive: z.boolean().default(true),
});

/**
 * AN EDIT TO A REDIRECT MAY ONLY WRITE WHAT THE SELLER SENT.
 *
 * This was `redirectCreateSchema.partial().strict()`, and the route spreads
 * `{ ...parsed.data }`. `.partial()` in zod 4 keeps every `.default()`.
 * MEASURED:
 *
 *     redirectCreateSchema.partial().strict().safeParse({ to: '/b' })
 *       → { to: '/b', kind: 302, isActive: true }
 *
 * So changing only the destination silently turned a permanent 301 into a
 * temporary 302, and switched back on a redirect somebody had deliberately
 * disabled. Both defaults are the right answer for a NEW redirect and the
 * wrong answer for an edit — see the file header on why 302 is the default
 * at all: a 301 the seller did not mean is close to unrecoverable on the
 * machines that cached it, and this door was handing out the reverse
 * mistake, quietly discarding a 301 the seller did mean.
 *
 * `isActive: true` mattered twice over, because `standDownRedirectsTo`
 * deactivates a redirect when a live page claims its address. A seller
 * editing the destination of one of those re-pointed it AND re-armed it
 * past a page that now exists.
 *
 * `.strict()` is kept: the route strips `accept` itself before parsing, so
 * anything else unknown in the body is still a 400.
 */
export const redirectUpdateSchema = z
  .object(omittedMeansOmitted(redirectCreateSchema.shape))
  .strict();

/**
 * A redirect that would send somebody straight back where they came from.
 *
 * `/a` → `/a` is an infinite loop in a browser's address bar. It is the one
 * mistake a seller makes by accident, usually by fixing a slug back.
 */
export function isSelfRedirect(from: string, to: string): boolean {
  return from === to || from === to.replace(/\/+$/, '');
}

/**
 * Which landing-page slug a `from` path is about, if any.
 *
 * Used for the ownership check: a redirect for /lp/<slug> is the one shape
 * that could point at somebody else's page.
 */
export function landingSlugOf(from: string): string | null {
  const m = /^\/lp\/([a-z0-9-]{2,60})$/.exec(from);
  return m ? m[1] : null;
}

/**
 * Whether this store may claim this `from` path.
 *
 * WHY THIS EXISTS, TWICE OVER. The public space is shared: /lp/<slug> is one
 * address for every company.
 *
 *  - Without a check, store A could add a redirect for store B's live slug
 *    and take B's paid traffic to A's shop.
 *  - And without the SAME check against its own company, a shop could
 *    redirect away from its OWN published page and quietly take it off the
 *    air — the paths differ, so the self-redirect guard never sees it.
 *
 * So the rule is one rule, and it is about the address rather than about who
 * asks: A LIVE PAGE ALWAYS WINS. A slug that any page currently holds cannot
 * be redirected away from, whoever owns it. A slug nobody holds can — which
 * is exactly the case after a rename, when the old address is free and the
 * advertisement is still pointing at it.
 *
 * A path under this store's own /s/<slug>/ is always allowed; anything else,
 * including the app's own paths and another store's, is refused.
 */
export async function mayClaimFrom(
  from: string,
  store: { id: string; slug: string; companyId: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (from === `/s/${store.slug}` || from.startsWith(`/s/${store.slug}/`)) return { ok: true };

  const slug = landingSlugOf(from);
  if (!slug) {
    return {
      ok: false,
      error: 'المسار القديم يجب أن يكون من عناوين متجرك: /lp/<معرّف-صفحة> أو مسار تحت /s/' + store.slug,
    };
  }

  const live = await db.landingPage.findFirst({ where: { slug }, select: { id: true, companyId: true } });
  if (live) {
    return {
      ok: false,
      error:
        live.companyId === store.companyId
          ? 'هذا العنوان تستعمله صفحة عندك الآن — تحويله سيُخفيها عن الزبائن'
          : 'هذا العنوان تستعمله صفحة تابعة لشركة أخرى — لا يمكن تحويله من هنا',
    };
  }

  /*
   * AN ADDRESS ANOTHER COMPANY ALREADY FORWARDS IS NOT FREE EITHER.
   *
   * Right after a rename the old address is free of pages, and the rename
   * leaves a redirect from it (suggested, then accepted) for the company
   * whose advert is still pointing there. `redirectFor` resolves a path
   * claimed twice to the OLDER claim, so a second company claiming it would
   * lose quietly — or, if the first were switched off, take over somebody
   * else's paid traffic. Refused here, in words, whoever claims second.
   * The same company's other shop is not "another company".
   */
  const held = await db.storeRedirect.findFirst({
    where: { from, companyId: { not: store.companyId } },
    select: { companyId: true },
  });
  // The query already excludes this company; the row is checked again so the
  // refusal never rests on the filter alone.
  if (held?.companyId && held.companyId !== store.companyId) {
    return { ok: false, error: 'هذا العنوان محجوز بتحويل تابع لشركة أخرى — لا يمكن تحويله من هنا' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────
// Matching, at request time
// ─────────────────────────────────────────────────────

export interface RedirectMatch {
  id: string;
  to: string;
  kind: RedirectKind;
}

const TTL_MS = 30_000;
let cache: { at: number; byPath: Map<string, RedirectMatch> } | null = null;

/**
 * The redirect for this path, or null.
 *
 * Cached for thirty seconds, like the host lookup next to it: this runs on
 * requests that would otherwise 404, and a table read on each of those is a
 * cheap way to be hurt by a crawler.
 *
 * A path claimed by two stores — possible only for a slug that was free
 * when both claimed it — resolves to the OLDER claim, the same tie-break
 * the slug rules already use, so the answer never depends on row order.
 */
export async function redirectFor(pathname: string): Promise<RedirectMatch | null> {
  if (!cache || Date.now() - cache.at >= TTL_MS) {
    try {
      const rows = await db.storeRedirect.findMany({
        where: { isActive: true, suggested: false },
        orderBy: { createdAt: 'asc' },
        select: { id: true, from: true, to: true, kind: true },
      });
      const byPath = new Map<string, RedirectMatch>();
      for (const row of rows) {
        // The first (oldest) claim on a path wins.
        if (!byPath.has(row.from)) {
          byPath.set(row.from, { id: row.id, to: row.to, kind: row.kind === 301 ? 301 : 302 });
        }
      }
      cache = { at: Date.now(), byPath };
    } catch {
      // A database briefly out of reach must not turn every page into an
      // error: the request carries on to the route it asked for.
      return null;
    }
  }
  return cache.byPath.get(pathname) ?? null;
}

/** Forget the table, so a redirect just saved takes effect at once. */
export function forgetRedirects(): void {
  cache = null;
}

/**
 * Count a redirect that was followed.
 *
 * Deliberately not awaited by the caller: the customer's redirect must not
 * wait on a counter, and a failed count is a missing number, not a missing
 * page. That makes the count best-effort, which is what the screen calls it.
 */
export function countRedirectHit(id: string): void {
  void db.storeRedirect
    .update({ where: { id }, data: { hits: { increment: 1 } } })
    .catch(() => {});
}

/**
 * A redirect whose `from` is now a live page's address is stood down.
 *
 * A LIVE PAGE ALWAYS WINS: an address that names a page must answer with
 * that page, not forward past it. Deactivated rather than deleted, so the
 * seller can see what happened and turn it back on if they meant it.
 *
 * NOT scoped to the company, deliberately. /lp/<slug> is one address for
 * everybody, and a redirect claimed by another company while the slug was
 * free would otherwise keep sending this page's visitors away — the page
 * would be unreachable and its owner would have nothing to look at. The
 * redirect was only ever allowed because nothing held the slug; something
 * does now.
 */
export async function standDownRedirectsTo(slug: string) {
  const stood = await db.storeRedirect.updateMany({
    where: { from: `/lp/${slug}`, isActive: true },
    data: { isActive: false },
  });
  if (stood.count > 0) forgetRedirects();
}

/**
 * The suggestion raised when a landing page's slug changes.
 *
 * Suggested, never applied: only the seller knows whether the old address
 * should keep working. Written with `suggested: true`, which is why
 * `redirectFor` filters those out — a suggestion nobody has looked at must
 * not already be forwarding traffic.
 */
export async function suggestSlugRedirect(args: {
  companyId: string;
  storeId: string | null;
  oldSlug: string;
  newSlug: string;
}): Promise<void> {
  if (!args.storeId || args.oldSlug === args.newSlug) return;
  const from = `/lp/${args.oldSlug}`;
  const to = `/lp/${args.newSlug}`;
  if (isSelfRedirect(from, to)) return;
  try {
    await db.storeRedirect.upsert({
      where: { storeId_from: { storeId: args.storeId, from } },
      // A path that already has a redirect keeps it: the seller decided that
      // one, and a rename is not a reason to overwrite a decision.
      update: {},
      create: {
        companyId: args.companyId,
        storeId: args.storeId,
        from,
        to,
        kind: 302,
        isActive: true,
        suggested: true,
      },
    });
  } catch {
    // A suggestion that cannot be written must not fail the rename.
  }
}
