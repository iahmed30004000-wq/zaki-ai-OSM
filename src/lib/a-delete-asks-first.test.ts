import { describe, expect, it } from 'vitest';
import { dashboardFiles, stripComments } from './guard-source';

/**
 * A DELETE THAT CANNOT BE TAKEN BACK ASKS FIRST (22/10).
 *
 * Twenty-odd places in the dashboard send a `DELETE`, and all but a handful already ask — in the app's own dialog (`useConfirm`), in
 * Arabic, with the dangerous button coloured as dangerous. Five did not: a channel, an offer, a system token, a courier's stored
 * account and a passkey went on one press of a small bin icon. Three of those are not undone at all (the token is revoked and nothing
 * sets it back; the courier's credentials are nulled and are never read back to restore; the passkey row is deleted), and the other two
 * are an afternoon of somebody's setup.
 *
 * This is the rule they now follow and the sweep that keeps it: every `method: 'DELETE'` in the dashboard's source is inside a handler
 * that asks first, or is named below with the reason it does not need to. The list is closed and every entry must still be needed — an
 * exemption for a site that now asks is a stale excuse, and fails.
 *
 * NOT asked here, on purpose: undo. A delete that is hidden and sent later, with a «تراجع» in between, is a different design and the
 * product has said no to it twice (a toast carries a LINK and never a callback; a button has no optimistic path), and the doors that
 * would need it most — a Telegram source, whose delete nulls the link on every message it ever received — cannot be restored by
 * creating the row again. See RV102.
 */

/** `file#handler` — or just `file` when the DELETE is not inside a named handler (an effect's cleanup). */
const EXEMPT: Record<string, string> = {
  'src/components/orders/OrderDetailModal.tsx':
    'releases the edit lock when the dialog closes — the system letting go of a hold it took, not a person deleting something',
  'src/components/shell/PreviewAs.tsx#leave':
    '«رجوع لحسابي» ends the owner’s read-only preview — it deletes no record, only the preview cookie, and nothing is lost by pressing it',
  'src/hooks/useOrderOwnership.ts#releaseLock':
    'releases the edit lock on an order — the same hold the dialog lets go of, taken by the system and not a person’s deletion',
  'src/components/orders/OrderResponsibility.tsx#run':
    'releasing an order is reached through a panel that demands a written reason before its button can be pressed',
  'src/components/screens/LandingPageDetailScreen.tsx#deleteRecommendation':
    'the storefront’s screen, not this PR’s to change; taking a suggested product off a page is undone by adding it again',
  'src/components/screens/UserDetailScreen.tsx#removeOverride':
    'taking an override off is undone by granting it again, the screen says what it did, and it is in the audit log',
  'src/components/settings/MenuOrderCard.tsx#reset':
    'resets a person’s OWN menu arrangement; undone by arranging it again, and the screen says «رجع الأساس»',
};

interface Site {
  file: string;
  name: string | null;
  asks: boolean;
  line: number;
}

const HEAD = /(?:async\s+function\s+(\w+)|const\s+(\w+)\s*=\s*(?:useCallback\(\s*)?async\b)/g;

function sitesOf(rel: string, raw: string): Site[] {
  const src = stripComments(raw).replace(/\r\n/g, '\n');
  const out: Site[] = [];
  for (const m of src.matchAll(/method:\s*'DELETE'/g)) {
    const at = m.index!;
    // The nearest handler head above it, no further than 3000 characters back.
    let head: { name: string; index: number } | null = null;
    for (const h of src.slice(Math.max(0, at - 3000), at).matchAll(HEAD)) {
      head = { name: h[1] ?? h[2], index: Math.max(0, at - 3000) + h.index! };
    }
    const segment = head ? src.slice(head.index, at) : '';
    const asks = /\b(?:confirm|ask)\s*\(/.test(segment) || /^confirm/i.test(head?.name ?? '');
    out.push({ file: rel.replace(/^\//, ''), name: head?.name ?? null, asks, line: src.slice(0, at).split('\n').length });
  }
  return out;
}

const files = dashboardFiles('both').filter((f) => !/\.test\./.test(f.rel));
const sites = files.flatMap((f) => sitesOf(f.rel, f.src));
const key = (s: Site) => (s.name && `${s.file}#${s.name}` in EXEMPT ? `${s.file}#${s.name}` : s.file);

describe('every delete the dashboard sends asks first', () => {
  it('— the sweep found the deletes, or it would be vacuous', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(sites.length).toBeGreaterThan(20);
  });

  it('— each is inside a handler that asks, or is named in the closed list with its reason', () => {
    const loose = sites.filter((s) => !s.asks && !(key(s) in EXEMPT)).map((s) => `${s.file}:${s.line}${s.name ? ` (${s.name})` : ''}`);
    expect(loose, `حذفٌ يُرسَل بلا سؤال:\n${loose.join('\n')}`).toEqual([]);
  });

  it('— and the five that used to go on one press now ask', () => {
    const FIVE: [string, string][] = [
      ['src/components/screens/ChannelsScreen.tsx', 'remove'],
      ['src/components/products/ProductOffers.tsx', 'remove'],
      ['src/components/apps/SystemTokensPanel.tsx', 'revoke'],
      ['src/components/settings/CourierCredentials.tsx', 'clear'],
      ['src/components/settings/PasskeySection.tsx', 'remove'],
    ];
    for (const [file, name] of FIVE) {
      const hit = sites.find((s) => s.file === file && s.name === name);
      expect(hit, `${file}#${name}: ما لقيتُ الحذف`).toBeTruthy();
      expect(hit!.asks, `${file}#${name}: يُرسَل بلا سؤال`).toBe(true);
    }
  });

  it('— and no exemption is stale: every one names a delete that exists and still does not ask', () => {
    const used = new Set(sites.filter((s) => !s.asks).map(key));
    for (const entry of Object.keys(EXEMPT)) {
      expect(used.has(entry), `إعفاءٌ لا حاجة له: ${entry}`).toBe(true);
      expect(EXEMPT[entry].length, `${entry}: بلا سبب`).toBeGreaterThan(30);
    }
  });

  it('— and the sweep can fail: a handler that sends a delete with no question is the thing it finds', () => {
    const bad = sitesOf('/src/components/x/Demo.tsx', `async function remove(id: string) {\n  await fetch('/api/x/' + id, { method: 'DELETE' });\n}`);
    expect(bad).toEqual([{ file: 'src/components/x/Demo.tsx', name: 'remove', asks: false, line: 2 }]);
    const good = sitesOf(
      '/src/components/x/Demo.tsx',
      `async function remove(id: string) {\n  if (!(await confirm({ title: 'حذف؟' }))) return;\n  await fetch('/api/x/' + id, { method: 'DELETE' });\n}`
    );
    expect(good[0].asks).toBe(true);
  });
});
