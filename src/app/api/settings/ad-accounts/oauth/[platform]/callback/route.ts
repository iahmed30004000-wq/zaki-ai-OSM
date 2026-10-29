import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { secretHint } from '@/lib/secrets';
import { adapterFor, isAdPlatform, writeCredentials } from '@/lib/ads';
import { exchangeCode, readState, STATE_REFUSALS } from '@/lib/ads/oauth';

/**
 * GET /api/settings/ad-accounts/oauth/:platform/callback
 *
 * Where the platform sends the browser back, carrying a `code`.
 *
 * ── IT ENDS IN A REDIRECT, NOT IN JSON ──
 *
 * A person is looking at this: they pressed «sign in», approved a consent
 * screen, and are now waiting. JSON in the address bar is what a developer
 * gets; a settings screen with a sentence on it is what a seller needs. So
 * every outcome — including every refusal — lands back on the settings
 * page with a short code in the query, and the screen turns that into
 * Arabic.
 *
 * The code goes in the query and nothing else does. Not the token, not the
 * error from the platform, not the state: a URL is written to logs,
 * proxies, browser history and error reports.
 *
 * ── THE STATE IS WHAT MAKES THIS SAFE ──
 *
 * Without it, anybody holding a `code` for THEIR ad account can hand it to
 * this URL while a victim is signed in, and the token for a stranger's
 * account is stored against the victim's company — whose every spend
 * figure then comes from somebody else's spending. The state says «this
 * company, this store, this platform, minutes ago», signed, and is checked
 * against the session before the code is spent.
 */

function back(outcome: string, extra: Record<string, string> = {}): NextResponse {
  const origin = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  const params = new URLSearchParams({ connect: outcome, ...extra });
  return NextResponse.redirect(`${origin}/settings?${params.toString()}`, { status: 302 });
}

export async function GET(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  try {
    const { platform } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settings.manage');

    if (!isAdPlatform(platform)) return back('unsupported');

    const url = new URL(req.url);

    /*
     * THE PLATFORM'S OWN REFUSAL COMES FIRST.
     *
     * A seller who presses «cancel» on the consent screen arrives here with
     * `error=access_denied` and no code. Reading the code first would
     * answer «no code» — true and useless. And the platform's error text is
     * NOT passed on: it is attacker-controlled text arriving in a query
     * string, and putting it on a page is how a redirect becomes a message
     * board. The screen has its own sentence for each outcome.
     */
    if (url.searchParams.get('error')) {
      const denied = url.searchParams.get('error') === 'access_denied';
      return back(denied ? 'declined' : 'platform-refused', { platform });
    }

    const verdict = readState(url.searchParams.get('state'), platform);
    if (!verdict.ok) {
      /*
       * Audited, because a bad state is either somebody taking ten minutes
       * over a consent screen or somebody trying to attach their ad account
       * to this company — and the two look identical from here. The row is
       * what lets the second be noticed.
       */
      await logAudit({
        companyId,
        userId: user.id,
        action: 'AD_ACCOUNT_OAUTH_REFUSED',
        entity: 'AdAccount',
        entityId: storeId ?? '',
        newData: { platform, reason: verdict.why },
      });
      return back('bad-state', { why: verdict.why });
    }

    /*
     * AND THE STATE MUST BE THIS SESSION'S.
     *
     * The signature proves WE issued it; it does not prove it was issued to
     * whoever is holding it. A state signed for company A, replayed by
     * somebody signed in as company B, would otherwise store A's flow
     * against B. Both halves are needed: the signature stops forgery, this
     * stops replay.
     */
    if (verdict.state.companyId !== companyId || (verdict.state.storeId ?? null) !== (storeId ?? null)) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'AD_ACCOUNT_OAUTH_REFUSED',
        entity: 'AdAccount',
        entityId: storeId ?? '',
        newData: { platform, reason: 'other-tenant' },
      });
      return back('bad-state', { why: 'other-tenant' });
    }

    const code = url.searchParams.get('code');
    if (!code) return back('no-code');

    const adapter = adapterFor(platform);
    if (!adapter) return back('unsupported');

    let credentials: Record<string, string>;
    try {
      ({ credentials } = await exchangeCode(platform, code));
    } catch {
      // The platform's own words are not shown — see above. One sentence.
      return back('exchange-failed', { platform });
    }

    /*
     * SIGNING IN DOES NOT NAME AN ACCOUNT, so the token is asked what it
     * reaches. A consent may cover one ad account or fourteen.
     */
    let accounts;
    try {
      accounts = await adapter.listAccounts(credentials);
    } catch {
      return back('list-failed', { platform });
    }
    if (accounts.length === 0) return back('no-accounts', { platform });

    /*
     * EVERY REACHABLE ACCOUNT GETS A ROW, and the seller deletes what they
     * do not want.
     *
     * The alternative — a picker — needs the token held somewhere between
     * two requests, which means a table, a cleanup job, and a window in
     * which a token sits in a row nobody has consented to yet. Creating
     * the rows is idempotent (`@@unique([companyId, storeId, platform,
     * accountId])`) and reversible with the delete button that already
     * exists, and the screen says how many arrived.
     *
     * `upsert`, so re-connecting refreshes the token on the rows already
     * there rather than failing on the unique.
     */
    const stored: { accountId: string; name: string }[] = [];
    for (const account of accounts) {
      const id = adapter.normalizeAccountId(account.id) ?? account.id;
      await db.adAccount.upsert({
        where: {
          companyId_storeId_platform_accountId: { companyId, storeId, platform, accountId: id },
        },
        create: {
          companyId, storeId, platform,
          accountId: id,
          accountName: account.name,
          tokenEncrypted: writeCredentials(credentials),
          tokenHint: secretHint(credentials[adapter.hintField] ?? ''),
          status: 'CONNECTED',
          createdById: user.id,
        },
        update: {
          accountName: account.name,
          tokenEncrypted: writeCredentials(credentials),
          tokenHint: secretHint(credentials[adapter.hintField] ?? ''),
          status: 'CONNECTED',
          lastError: null,
        },
      });
      stored.push({ accountId: id, name: account.name });
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'AD_ACCOUNT_CONNECTED',
      entity: 'AdAccount',
      entityId: storeId ?? '',
      // The accounts and who did it. Never the token, not even its hint —
      // an audit log is read by more people than a settings screen.
      newData: { platform, via: 'oauth', accounts: stored, by: user.name },
    });

    return back('connected', { platform, count: String(stored.length) });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
