import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { conversionEventId } from './conversions/types';
import { conversionValue } from './conversions/emit';
import { defaultValueSource } from '@/app/api/settings/conversions/route';

/**
 * تشطيب ١ — STAGE 1: THE COMMITMENTS LEDGER, attribution.
 *
 * «Order fields: source_type, page_id, campaign_id, adset_id, ad_id,
 *  ctwa_clid. Captured ONCE, never overwritten.
 *  WhatsApp CTWA sends referral.source_id and ctwa_clid on the FIRST message
 *  only…
 *  Conversion values sent to ad platforms use the COLLECTED amount at
 *  DELIVERED, not the ordered amount, deduplicated by event_id. The
 *  per-campaign delivery rate is a reported metric, never a multiplier
 *  applied to events.»
 *
 * The attribution is modelled more normally than the contract's flat field
 * list and holds where it matters. Two of the named fields do not exist at
 * all, and the whole CTWA paragraph is unbuilt — pinned as unbuilt.
 */

describe('1 · the attribution a paid order carries', () => {
  const order = (() => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model Order {'));
    return m.slice(0, m.indexOf('\n}'));
  })();

  it('is normalised into relations, not copied strings', () => {
    /*
     * The contract names `source_type, page_id, campaign_id`. The code has
     * `source` (the free-text door), `channelId → OrderChannel`,
     * `campaignId → Campaign` and `landingPageId → LandingPage` — the same
     * facts as rows, so renaming a campaign does not orphan last month's
     * orders.
     */
    expect(order).toMatch(/channelId\s+String\?/);
    expect(order).toMatch(/campaignId\s+String\?/);
    expect(order).toMatch(/landingPageId\s+String\?/);
    expect(order).toMatch(/source\s+String\s+@default\("Manual"\)/);
  });

  it('and the campaign keeps the platform’s own id, not a name', () => {
    // Matching by name breaks the first time somebody renames a campaign in
    // Ads Manager.
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model Campaign {'));
    expect(m.slice(0, m.indexOf('\n}'))).toMatch(/externalId\s+String\?\s+@map\("external_id"\)/);
  });

  it('and a campaign is NOT the same thing as a channel', () => {
    // Two Meta campaigns at once are one channel and two budgets. Folding
    // them would make every source report unable to answer «which ad».
    expect(repoFile('prisma/schema.prisma')).toMatch(/a channel is the door \(Facebook, WhatsApp,/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 2 · «Captured ONCE, never overwritten» — held, with one deliberate seam.
 *
 * `campaignId`, `landingPageId` and `source` are written when the order is
 * born and NO route can change them. `channelId` can be changed — but only
 * by somebody holding `orders.assign`, which is a different authority from
 * fixing an address, and the route says so in its own words.
 *
 * That seam is the right one: a campaign is a fact about where the click
 * came from, and a channel is a judgement somebody may have entered wrong.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('2 · attribution is captured once', () => {
  const SRC = join(__dirname, '..');
  function files(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) files(p, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  /**
   * Files that ASSIGN one of the immutable fields in an update payload.
   *
   * `split(sep).join('/')` is not decoration: on Windows the path comes back
   * with backslashes, so a `startsWith('app/api/orders/')` filter matched
   * nothing and the guard passed while the mutation that proved it was
   * sitting in the file.
   */
  const rewriters = (field: string) =>
    files(SRC)
      .map((p) => ({
        f: p.slice(SRC.length + 1).split(sep).join('/'),
        text: stripComments(readFileSync(p, 'utf8')),
      }))
      .filter(({ text }) => new RegExp(`updateData\\.${field}\\s*=|data: \\{[^}]*\\b${field}:`).test(text))
      .map(({ f }) => f);

  it.each(['campaignId', 'landingPageId'])('%s is never rewritten by an edit route', (field) => {
    const offenders = rewriters(field).filter((f) => f.startsWith('app/api/orders/'));
    expect(offenders, `يُعاد كتابة ${field} في:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and the one field that CAN move credit is gated on a separate authority', () => {
    const route = stripComments(repoFile('src/app/api/orders/[id]/route.ts'));
    expect(route).toMatch(/if \(!can\(user, 'orders\.assign'\)\)/);
    expect(route).toMatch(/code: 'CHANNEL_FORBIDDEN'/);
    // And the reason is written where the guard is, not in a ticket.
    expect(repoFile('src/app/api/orders/[id]/route.ts')).toMatch(
      /A confirmation agent editing the order she is working on must not be/
    );
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 3 · the conversion value — THE DEFAULT WAS THE LIE THE MODULE NAMES.
 *
 * `conversions/types.ts` states the rule exactly: «At delivery, the collected
 * amount is the truth and the order total is a wish… Sending the total there
 * would teach Meta that every delivery is worth full price, which is the same
 * lie the delivery-rate multiplier was invented to patch.»
 *
 * And the save door defaulted EVERY conversion to `ORDER_TOTAL`, including
 * one triggered at delivery. Fixed 2026-10-02: the trigger decides.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('3 · what the ad platform is told a sale was worth', () => {
  it('a delivery-triggered conversion defaults to the COLLECTED amount', () => {
    expect(defaultValueSource('order.delivered')).toBe('COLLECTED_AMOUNT');
  });

  it('and the earlier triggers default to the order total, which is right there', () => {
    // Nothing has been collected yet; `collectedAmount` would read as the
    // total anyway and only the name would change.
    expect(defaultValueSource('order.created')).toBe('ORDER_TOTAL');
    expect(defaultValueSource('order.confirmed')).toBe('ORDER_TOTAL');
  });

  it('and it is a DEFAULT, not a prohibition — a seller may still say otherwise', () => {
    const door = stripComments(repoFile('src/app/api/settings/conversions/route.ts'));
    expect(door).toMatch(/valueSource: z\.enum\(VALUE_SOURCES\)\.optional\(\)/);
    expect(door).toMatch(/parsed\.data\.valueSource \?\? defaultValueSource\(trigger\)/);
    // The flat default that caused it must not come back.
    expect(door).not.toMatch(/z\.enum\(VALUE_SOURCES\)\.default\('ORDER_TOTAL'\)/);
  });

  it('and a whole delivery is worth its total, not zero', () => {
    // `collectedAmount` is recorded ONLY on a partial delivery. Null means
    // «everything was collected», and reading it as zero would report every
    // complete sale as worthless.
    expect(conversionValue('COLLECTED_AMOUNT', { totalAmount: 32, collectedAmount: null })).toBe(32);
    expect(conversionValue('COLLECTED_AMOUNT', { totalAmount: 40, collectedAmount: 23 })).toBe(23);
  });

  it('and the delivery rate is NEVER applied to an event', () => {
    // «a reported metric, never a multiplier». A swept check, because the
    // temptation is to "correct" the value by the campaign's rate.
    const SRC = join(__dirname, 'conversions');
    const offenders = readdirSync(SRC)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
      .filter((f) => /deliveryRate|delivery_rate/.test(stripComments(readFileSync(join(SRC, f), 'utf8'))));
    expect(offenders, `نسبة التسليم دخلت حساب الحدث:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('4 · one event is counted once', () => {
  it('the id is derived from the conversion and the order, not generated', () => {
    // A random id per attempt means Meta counts a retry as a second sale.
    expect(conversionEventId('abcdef0123456789', 'order-1')).toBe('abcdef01.order-1');
    expect(conversionEventId('abcdef0123456789', 'order-1')).toBe(
      conversionEventId('abcdef0123456789', 'order-1')
    );
  });

  it('and it is stored on the delivery row, so a retry reuses it', () => {
    const emit = stripComments(repoFile('src/lib/conversions/emit.ts'));
    expect(emit).toMatch(/eventId: conversionEventId\(c\.id, orderId\)/);
    expect(emit).toMatch(/event_id: delivery\.eventId/);
  });

  it('and the two-decimal rounding there is pinned as deliberate', () => {
    // Seven places were fixed to `roundMinor` on 2026-10-02 and this one was
    // not; the reason must stay beside it or the next sweep "fixes" it.
    const emit = repoFile('src/lib/conversions/emit.ts');
    expect(emit).toMatch(/TWO DECIMALS HERE IS DELIBERATE/);
    expect(emit).toMatch(/not a figure anybody settles on/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * REPORTED, NOT CAPTURED — and what is still not built at all.
 *
 * THIS BLOCK USED TO PIN `ad_id` AND `ctwa_clid` AS ABSENT, and O7 moved
 * them. `/api/v1` lets another system hand this one an order it has already
 * attributed, so `Order` now carries `adId`, `adSourceType`, `ctwaClidEnc`,
 * `refCode`, `touchAt`, `pageId`, `psidEnc`, `wabaId`, `conversationRef`
 * and `externalRef` — REPORTED facts, written once at creation by the
 * systems door and by nothing else.
 *
 * WHAT DID NOT CHANGE IS WHO DOES THE ATTRIBUTING. This system still
 * captures no click of its own: the WhatsApp webhook reads no `referral`,
 * no `source_id` and no `ctwa_clid`, so a click-to-WhatsApp sale arriving
 * through OUR door is still attributed to the WhatsApp channel and no
 * further. The pinned absence becomes a pinned presence with its boundary
 * beside it, rather than disappearing — which is how this file has handled
 * every other half-built thing.
 *
 * · `adset_id` still does not exist as a column. The standalone landing door
 *   now reports one (utm_term) and the owner had it kept in `refCode`
 *   (`v1/landing-attribution.ts`), so no adset column was added.
 * · The click id and the chat account are ENCRYPTED columns, and no
 *   endpoint returns either. «Ad tokens reach no model at all» is the
 *   owner's rule; these do not reach a screen either.
 * · AND THE LANDING DOOR'S REPORTED FACTS (contract oms-lp.v1 §4): the
 *   Meta campaign id, the landing system's page id, the visitor's browser
 *   and the landing system's Purchase event id are plain nullable columns
 *   beside the others; Meta's click and browser cookies are SEALED, under
 *   the same `…Enc` rule as the click id — so the lists below gained them.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('the ad evidence an order can carry, and what is still not built', () => {
  const schema = () => repoFile('prisma/schema.prisma');

  it('there is no adset id anywhere', () => {
    expect(schema()).not.toMatch(/adsetId|adset_id/i);
  });

  it('and the reported fields exist on the order, as nullable columns', () => {
    const m = schema().slice(schema().indexOf('model Order {'));
    const order = m.slice(0, m.indexOf('\n}'));
    for (const column of [
      'externalRef',
      'adId',
      'adSourceType',
      'refCode',
      'touchAt',
      'pageId',
      'wabaId',
      'conversationRef',
      // The landing door's (contract oms-lp.v1 §4).
      'metaCampaignId',
      'externalLandingPageId',
      'clientUserAgent',
      'lpPurchaseEventId',
    ]) {
      // Nullable with no default: the migration writes into no existing row.
      expect(order, column).toMatch(new RegExp(`${column}\\s+(?:String|DateTime)\\?`));
    }
  });

  it('and the click id and the chat account are sealed, never plain columns', () => {
    const s = schema();
    // The `…Enc` names are the contract with every later reader: a column
    // called `ctwaClid` holding plaintext would be read as sealed by
    // everybody who met it afterwards.
    expect(s).toMatch(/ctwaClidEnc\s+String\?/);
    expect(s).toMatch(/psidEnc\s+String\?/);
    expect(s).not.toMatch(/\bctwaClid\s+String/);
    expect(s).not.toMatch(/\bpsid\s+String/);
    // Meta's click and browser cookies, from the landing door: sealed the same way.
    expect(s).toMatch(/fbcEnc\s+String\?/);
    expect(s).toMatch(/fbpEnc\s+String\?/);
    expect(s).not.toMatch(/\bfbc\s+String/);
    expect(s).not.toMatch(/\bfbp\s+String/);
  });

  it('and they are written through encryptSecret, by the systems door alone', () => {
    const intake = stripComments(repoFile('src/lib/v1/order-intake.ts'));
    expect(intake).toMatch(/encryptSecret\(/);
    expect(intake).toMatch(/ctwaClidEnc: sealed\(/);
    expect(intake).toMatch(/psidEnc: sealed\(/);
    // And the landing door's cookies, through the same function, by the landing door alone.
    const landing = stripComments(repoFile('src/lib/v1/landing-attribution.ts'));
    expect(landing).toMatch(/encryptSecret\(/);
    expect(landing).toMatch(/fbcEnc: sealed\(/);
    expect(landing).toMatch(/fbpEnc: sealed\(/);
  });

  it('and no endpoint hands either of them back', () => {
    // The landing door's sealed cookies too: no route names them (the conversions sender opens them for Meta only).
    const sealed = /ctwaClid|psidEnc|fbcEnc|fbpEnc/;
    const leaking = routeFiles()
      .filter((rel) => sealed.test(stripComments(repoFile(rel))))
      .filter((rel) => rel !== 'src/lib/v1/order-intake.ts');
    expect(
      leaking,
      `بابٌ يُعيد معرِّفَ نقرةٍ أو حسابَ محادثةٍ — وهما مشفَّران بالقصد:\n${leaking.join('\n')}`
    ).toEqual([]);
  });

  it('and this system still captures no CTWA click of its own', () => {
    const hook = stripComments(repoFile('src/app/api/webhooks/whatsapp/route.ts'));
    expect(hook).not.toMatch(/referral|ctwa|source_id/i);
  });
});

/** Every `route.ts` under `src/app/api`, found rather than listed. */
function routeFiles(): string[] {
  const root = join(process.cwd(), 'src', 'app', 'api');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('route.ts')) out.push(p.slice(process.cwd().length + 1).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}
