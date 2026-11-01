import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from '../guard-source';
import { V1_CODE, V1Fault, requestIdOf, v1FaultBody } from './door';
import { V1_SCOPES } from './system-token';
import { amountString, isoWithOffset } from './shape';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * O7 — THE DOOR, SWEPT RATHER THAN LISTED.
 *
 * The behavioural files beside this one prove what each piece DOES. This
 * one holds the properties that must be true of the WHOLE tree, including
 * the route somebody adds next year — because the failures that matter at
 * a door another company's software calls are the ones nobody writes a test
 * for:
 *
 *   · a sixth handler lands with no `requireSystemToken` and the screen
 *     never shows it, so nobody notices the door standing open
 *   · a write loses its `Idempotency-Key` and one retry becomes two orders
 *   · a `companyId` creeps into a body or a query string, and the tenant
 *     stops being the token's
 *   · a customer's name, phone or address reaches a model, which is the
 *     one thing AGENTS.md calls a fixed blocker
 *   · an endpoint starts returning the sealed click id
 *
 * So the tree is WALKED. A list would be complete on the day it was
 * written — this repository has recorded that failure by name more than
 * once — and the thing being guarded here is specifically what arrives
 * later.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ROOT = process.cwd();
const DOOR = join(ROOT, 'src', 'app', 'api', 'v1');
const LIB = join(ROOT, 'src', 'lib', 'v1');

const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

function filesUnder(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (match.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Source with comments blanked: prose about a rule is not the rule. */
const read = (p: string) => stripComments(readFileSync(p, 'utf8'));

const ROUTES = filesUnder(DOOR, /^route\.ts$/).map(rel).sort();
const LIBS = filesUnder(LIB, /\.ts$/)
  .filter((p) => !/\.test\./.test(p))
  .map(rel)
  .sort();

/** One `export async function GET|POST|…` body at a time. */
interface Handler {
  file: string;
  method: string;
  body: string;
}

function handlers(): Handler[] {
  const out: Handler[] = [];
  for (const file of ROUTES) {
    const src = read(join(ROOT, file));
    const marks = [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
    for (let i = 0; i < marks.length; i++) {
      out.push({
        file,
        method: marks[i][1],
        body: src.slice(marks[i].index!, marks[i + 1]?.index ?? src.length),
      });
    }
  }
  return out;
}

describe('the door was found at all — a sweep over nothing proves nothing', () => {
  it('has the five endpoints the contract names, and the media buyer’s one read', () => {
    // The sixth (2026-10-26) is `orders/attribution`, read-only, for the
    // media buyer — `the-media-buyers-door.test.ts` holds what it answers.
    expect(ROUTES).toEqual([
      'src/app/api/v1/customers/lookup/route.ts',
      'src/app/api/v1/orders/[id]/notes/route.ts',
      'src/app/api/v1/orders/[id]/route.ts',
      'src/app/api/v1/orders/attribution/route.ts',
      'src/app/api/v1/orders/route.ts',
      'src/app/api/v1/products/route.ts',
    ]);
  });

  it('and handlers in them', () => {
    expect(handlers().length).toBeGreaterThanOrEqual(5);
  });

  it('and the five replies scopes, plus the media buyer’s two read-only ones, and not an eighth', () => {
    // «صلاحيات توكن الردود: products.read · customers.lookup · orders.create
    // · orders.read · orders.note — ولا شي غيرها.» — still exactly those five
    // on the replies key (`REPLIES_SCOPES`); the two added on 2026-10-26 are
    // the media buyer's and grant no write.
    expect([...V1_SCOPES].sort()).toEqual([
      'customers.lookup',
      'orders.attribution.read',
      'orders.create',
      'orders.note',
      'orders.read',
      'products.costs.read',
      'products.read',
    ]);
  });
});

describe('every handler proves the key before it does anything', () => {
  it('and the scope it asks for is one this product defines', () => {
    const bare: string[] = [];
    const unknown: string[] = [];
    for (const h of handlers()) {
      const m = /requireSystemToken\(\s*req\s*,\s*'([^']+)'\s*\)/.exec(h.body);
      if (!m) {
        bare.push(`${h.method.padEnd(6)} ${h.file}`);
        continue;
      }
      if (!(V1_SCOPES as readonly string[]).includes(m[1])) {
        unknown.push(`${h.method} ${h.file} → ${m[1]}`);
      }
    }
    expect(bare, `مُعالِجٌ على /api/v1 بلا إثباتِ مفتاح:\n${bare.join('\n')}`).toEqual([]);
    expect(unknown, `صلاحيةٌ غيرُ معرَّفة:\n${unknown.join('\n')}`).toEqual([]);
  });

  it('and it is the FIRST thing in the handler, before any query', () => {
    /*
     * A door that reads the database before it knows who is calling is a
     * door a stranger can make do work for free — and, worse, one whose
     * early `findFirst` has to remember the tenant on its own.
     */
    const late: string[] = [];
    for (const h of handlers()) {
      const guard = h.body.indexOf('requireSystemToken(');
      const query = h.body.search(/\bdb\.\w+\.(?:find|aggregate|count|create|update)/);
      if (guard === -1) continue;
      if (query !== -1 && query < guard) late.push(`${h.method} ${h.file}`);
    }
    expect(late, `استعلامٌ قبل إثباتِ المفتاح:\n${late.join('\n')}`).toEqual([]);
  });

  it('and nothing in the tree reads a company from the request', () => {
    /*
     * THE TENANT RULE AS A PROPERTY OF THE TREE. `requireSystemToken`
     * returns the `companyId` from the token; a handler that also accepted
     * one would let a caller name a company it has no key to.
     */
    const offenders: string[] = [];
    for (const file of [...ROUTES, ...LIBS]) {
      const src = read(join(ROOT, file));
      for (const m of src.matchAll(/(?:searchParams\.get|body|input|parsed\.data)[^;\n]*\bcompanyId\b/g)) {
        offenders.push(`${file} → ${m[0].trim().slice(0, 70)}`);
      }
    }
    expect(
      offenders,
      `الشركةُ تُقرأ من الطلبِ لا من المفتاح:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});

describe('every write is idempotent, because the caller retries', () => {
  it('and each one claims a key, stores its answer, and gives it back on failure', () => {
    const missing: string[] = [];
    for (const h of handlers()) {
      if (h.method === 'GET') continue;
      for (const needed of ['idempotencyKeyOf(', 'claimIdempotency(', 'rememberIdempotency(', 'releaseIdempotency(']) {
        if (!h.body.includes(needed)) missing.push(`${h.method} ${h.file} — ينقصه «${needed}»`);
      }
    }
    expect(missing, `كتابةٌ بلا حمايةٍ من التكرار:\n${missing.join('\n')}`).toEqual([]);
  });

  it('and the fingerprint is of the path that ARRIVED, not a literal one', () => {
    /*
     * A hard-coded path could drift from the folder the file sits in
     * without anything noticing, and two endpoints hashing the same string
     * would make one key's answer replay for the other.
     */
    for (const h of handlers()) {
      if (h.method === 'GET') continue;
      expect(h.body, `${h.method} ${h.file}`).toMatch(
        /requestFingerprint\(\s*'[A-Z]+'\s*,\s*new URL\(req\.url\)\.pathname\s*,/
      );
    }
  });
});

describe('not one byte of this reaches a model', () => {
  it('nothing in the tree imports the AI layer, at all', () => {
    /*
     * «ولا مسار بالباب بيبعت نص لأي موديل ذكاء (داخلي أو خارجي)» — and the
     * reason is the body: a name, a phone and an address. AGENTS.md makes
     * «a customer's name, phone or address sent to an external model» a
     * fixed blocker, and the safe version of that rule at this door is not
     * «use localOnly» but «there is no model here».
     */
    const offenders: string[] = [];
    for (const file of [...ROUTES, ...LIBS]) {
      const src = read(join(ROOT, file));
      if (/aiChat|ai-provider|ai-prompts|openrouter|OPENROUTER/i.test(src)) offenders.push(file);
    }
    expect(offenders, `بابٌ يَلمسُ موديلَ ذكاء:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and makes no outbound call of its own either', () => {
    // A `fetch` in here would be a third party nobody declared, reached
    // with a customer's details in hand.
    const offenders: string[] = [];
    for (const file of [...ROUTES, ...LIBS]) {
      if (/(?:^|[^.\w])fetch\s*\(/.test(read(join(ROOT, file)))) offenders.push(file);
    }
    expect(offenders, `نداءٌ خارجيٌّ من الباب:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('what the door never hands back', () => {
  it('the sealed click id and the sealed chat account, from anywhere', () => {
    const offenders: string[] = [];
    for (const file of ROUTES) {
      const src = read(join(ROOT, file));
      if (/ctwaClid|psidEnc|ctwa_clid/.test(src)) offenders.push(file);
    }
    expect(offenders, `بابٌ يُعيد معرِّفاً مشفَّراً بالقصد:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and a customer’s name or address from the lookup — «بلا اسم ولا عنوان بالرد»', () => {
    /*
     * The replies system is already talking to the person: it has their
     * name, because they typed it. What it cannot know is whether this is
     * their fourth order and whether somebody here has blocked them. So the
     * answer is a count, a value and a yes/no — and a webhook pointed at
     * the wrong host leaks nothing a customer would mind.
     */
    const src = read(join(ROOT, 'src/app/api/v1/customers/lookup/route.ts'));
    // The SELECT is the proof, not the response shape: a widened select is
    // how a field ends up in a spread later.
    const select = /select:\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
    expect(select).not.toMatch(/fullName|address|altPhone|notes|rawPhone/);
    expect(src).not.toMatch(/fullName|\baddress\b|altPhone/);
  });

  it('and no cost of goods or stock COUNT from the catalogue', () => {
    // «بلا تكلفة ولا مخزون رقمي حساس». A status word answers «can I promise
    // this?»; a number answers «how much does this shop hold?», which is a
    // competitor's question.
    const src = read(join(ROOT, 'src/app/api/v1/products/route.ts'));
    expect(src).not.toMatch(/productCost|estimatedCostOfGoods|unitCost/);
    // The free figure is read, and only ever compared — never published.
    expect(src).toMatch(/stock_status:/);
    expect(src).not.toMatch(/stock(?:_count|OnHand)?:\s*free/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * AN EXISTING ORDER'S MONEY IS READ, NEVER RECOMPUTED.
 *
 * S7 put `OrderAddOn` on the thank-you page: a customer may add a product
 * AFTER ordering, and the courier collects it. `computeCod` takes `addOns`
 * for exactly that reason, and `money.ts` says why in writing — «the
 * add-on raised the order's total when it was accepted, and the next
 * recompute … rebuilt the total from the lines alone and wrote it back. The
 * courier collected the order without the add-on.»
 *
 * So a door that answered «what is this order worth?» by totalling its
 * LINES would disagree with the figure `order.confirmed` carries, which is
 * `Number(order.totalAmount)` — the committed column. Two numbers for one
 * order, and the replies system matching on the wrong one.
 *
 * This door never recomputes. `createSystemOrder` prices a NEW order, where
 * there is nothing to add on to yet; every read of an order that already
 * exists takes the stored column.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('an existing order’s money is read, never recomputed', () => {
  it('no route in the tree totals an order it did not just create', () => {
    const offenders: string[] = [];
    for (const file of ROUTES) {
      const src = read(join(ROOT, file));
      for (const m of src.matchAll(/\b(?:computeCod|codForOrder|allocateDiscount)\s*\(/g)) {
        offenders.push(`${file} → ${m[0]}`);
      }
    }
    expect(
      offenders,
      `بابٌ يُعيدُ حسابَ مالِ طلبٍ قائمٍ من أسطرِه — والزيادةُ بعدَ الطلب تَسقُط:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('and the one figure it reports for a past order is the stored column', () => {
    // `totalAmount` is what `order.confirmed` and `order.shipped` carry, and
    // what settlement reconciles against. Summing `orderItem.lineTotal`
    // instead would drop every accepted add-on.
    const lookupSrc = read(join(ROOT, 'src/app/api/v1/customers/lookup/route.ts'));
    expect(lookupSrc).toMatch(/_sum: \{ totalAmount: true \}/);
    expect(lookupSrc).not.toMatch(/orderItem|lineTotal/);
  });

  it('and the status endpoint reports no money at all, so it cannot disagree', () => {
    const statusSrc = read(join(ROOT, 'src/app/api/v1/orders/[id]/route.ts'));
    expect(statusSrc).not.toMatch(/totalAmount|sellingPrice|collectedAmount|lineTotal/);
  });
});

describe('the refusal envelope another system parses', () => {
  it('is {error:{code,message,details},request_id} and nothing else', () => {
    const body = v1FaultBody('rep_1', new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'bad', { field: 'x' }));
    expect(Object.keys(body).sort()).toEqual(['error', 'request_id']);
    expect(Object.keys(body.error as object).sort()).toEqual(['code', 'details', 'message']);
    expect(body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'bad', details: { field: 'x' } },
      request_id: 'rep_1',
    });
  });

  it('and `details` is null rather than missing, so a parser never sees two shapes', () => {
    const body = v1FaultBody('rep_1', new V1Fault(404, V1_CODE.NOT_FOUND, 'gone'));
    expect((body.error as { details: unknown }).details).toBeNull();
  });

  it('and every code the tree throws is one the contract declares', () => {
    const declared = new Set(Object.values(V1_CODE));
    const unknown: string[] = [];
    for (const file of [...ROUTES, ...LIBS]) {
      if (file.endsWith('src/lib/v1/door.ts')) continue; // the declaration itself
      const src = read(join(ROOT, file));
      for (const m of src.matchAll(/V1_CODE\.([A-Z_]+)/g)) {
        if (!declared.has(m[1] as never)) unknown.push(`${file} → ${m[1]}`);
      }
    }
    expect(unknown, `رمزُ خطأٍ غيرُ معلَن:\n${unknown.join('\n')}`).toEqual([]);
  });
});

describe('the request id the caller chooses', () => {
  it('is echoed, so a failure there and a log line here can be put side by side', () => {
    expect(requestIdOf(new Request('https://x.test/', { headers: { 'x-request-id': 'rep_SY-2026-0148' } }))).toBe(
      'rep_SY-2026-0148'
    );
  });

  it('and is sanitised, because a header carrying a newline splits a response', () => {
    const id = requestIdOf(
      new Request('https://x.test/', { headers: { 'x-request-id': 'rep_1 X-Evil: yes' } })
    );
    expect(id).not.toMatch(/[\r\n ]/);
    expect(id).toBe('rep_1X-Evil:yes');
  });

  it('and is bounded, because it is written into a header', () => {
    const id = requestIdOf(new Request('https://x.test/', { headers: { 'x-request-id': 'a'.repeat(500) } }));
    expect(id).toHaveLength(80);
  });

  it('and one is made when none was sent, so every answer has one', () => {
    expect(requestIdOf(new Request('https://x.test/'))).toMatch(/^oms_[0-9a-f-]{36}$/);
  });
});

describe('money leaves this door as a string, at the currency’s own places', () => {
  it('two for the dollar, exactly as the contract’s examples read', () => {
    expect(amountString(15, 2)).toBe('15.00');
    expect(amountString(0, 2)).toBe('0.00');
    expect(amountString(33.5, 2)).toBe('33.50');
  });

  it('and THREE for the dinar, which is where this departs from the written contract', () => {
    /*
     * The contract says «نص عشري بخانتين». The dinar has three places, and
     * `a-fils-is-not-a-rounding-error.test.ts` exists because
     * `2.555::numeric(12,2)` is `2.56` — «five fils were lost on the way
     * INTO the column, every time, silently». Printing a JOD total at two
     * places here would reinvent that one layer out: the replies system
     * would quote a figure five fils below what the courier collects.
     *
     * Flagged for the owner in the PR as «قرار مؤقت». Losing fils is money,
     * and money is his ruling, not this function's.
     */
    expect(amountString(2.555, 3)).toBe('2.555');
    expect(amountString(15, 3)).toBe('15.000');
  });

  it('and never fewer than two, whatever it is handed', () => {
    expect(amountString(15, 0)).toBe('15.00');
    expect(amountString(15, 1)).toBe('15.00');
    expect(amountString(15, Number.NaN)).toBe('15.00');
  });

  it('and refuses a figure that is not a figure, rather than printing «NaN»', () => {
    // A quiet zero is a lie a parser cannot see; «NaN» inside a signed body
    // is a rejection the other side can.
    expect(() => amountString(Number.NaN, 2)).toThrow();
    expect(() => amountString(Infinity, 2)).toThrow();
  });
});

describe('a moment leaves this door with its offset', () => {
  it('in the zone the order happened in, not as a bare Z', () => {
    // «2026-10-09T17:14:00Z» and «20:14 +03:00» are one instant, and the
    // first reads three hours early to anybody in Amman.
    const at = new Date('2026-10-09T17:14:00.000Z');
    expect(isoWithOffset(at, 'Asia/Amman')).toBe('2026-10-09T20:14:00+03:00');
    expect(isoWithOffset(at, 'UTC')).toBe('2026-10-09T17:14:00+00:00');
  });

  it('and the offset is computed for THAT date, not taken from a table', () => {
    /*
     * Jordan abolished daylight saving in 2022 and Syria did not, so a
     * constant «+03:00» is wrong somewhere twice a year. `Intl` knows the
     * rules for the date in hand.
     */
    const winter = new Date('2026-01-15T12:00:00.000Z');
    const summer = new Date('2026-07-15T12:00:00.000Z');
    expect(isoWithOffset(winter, 'Europe/Berlin')).toBe('2026-01-15T13:00:00+01:00');
    expect(isoWithOffset(summer, 'Europe/Berlin')).toBe('2026-07-15T14:00:00+02:00');
  });

  it('and midnight is 00, not 24', () => {
    expect(isoWithOffset(new Date('2026-10-09T21:00:00.000Z'), 'Asia/Amman')).toBe(
      '2026-10-10T00:00:00+03:00'
    );
  });

  it('and an unreadable date throws rather than printing «Invalid Date»', () => {
    expect(() => isoWithOffset(new Date('nonsense'), 'UTC')).toThrow();
  });
});

describe('the intake reuses every shared rule, and owns none of them', () => {
  const intake = read(join(ROOT, 'src/lib/v1/order-intake.ts'));

  it('calls each one, rather than importing it and deciding for itself', () => {
    /*
     * THE CALL, NOT THE NAME. This repository has recorded four times in
     * one day that a guard asking whether a name is present was satisfied
     * by the import line of the thing that had been deleted.
     */
    for (const call of [
      /findOrCreateCustomer\(\s*db\b/,
      /activeBlock\(\s*db\b/,
      /resolveRegionId\(\s*db\b/,
      /activeOffersFor\(\s*db\b/,
      /computeCod\(\s*\{/,
      /priceIncludesDeliveryFor\(\s*store\.id/,
      // (old → new, 1/11) `productCosts(db` → the one helper the other order doors read, which answers the fixed cost first.
      /unitCostsOf\(\s*\n?\s*db\b/,
      /orderRefFields\(\s*tx\b/,
      /logAudit\(\s*\{/,
      /notify\(\s*\{/,
    ]) {
      expect(intake, `${call}`).toMatch(call);
    }
  });

  it('and grows no second pricing rule of its own', () => {
    // Two doors costing one order two ways is the drift `product-cost.ts`
    // and `money.ts` were written to end.
    expect(intake).not.toMatch(/toFixed\(\s*2\s*\)/);
    expect(intake).not.toMatch(/Math\.round\([^)]*\*\s*100\s*\)/);
    // The rounding that does happen is the currency's own.
    expect(intake).toMatch(/roundMinor\([^)]*country\.minorUnit/);
  });

  it('and takes its quantity bound from the shared reader, never z.coerce', () => {
    // `z.coerce.number()` turns '', '  ', null and [] into 0 and writes it
    // — refused outright by `a-column-has-one-rule.test.ts`.
    expect(intake).not.toMatch(/z\.coerce\.number\(\)/);
    expect(intake).toMatch(/count\(999,\s*1\)/);
  });

  it('and writes the order on a TRANSACTION client, with its lines', () => {
    expect(intake).toMatch(/\$transaction/);
    expect(intake).toMatch(/tx\.order\.create\(/);
    expect(intake).toMatch(/tx\.orderItem\.createMany\(/);
    expect(intake).not.toMatch(/db\.order\.create\(/);
    expect(intake).not.toMatch(/db\.orderItem\.create/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE ONE THING THIS DOOR DELIBERATELY DOES NOT DO.
 *
 * The specification lists `emitAppEvent('order.created')` among the things
 * the intake reuses. It is not called, and that is pinned here so the
 * absence reads as a decision rather than an oversight.
 *
 * `src/lib/apps/events-sites.test.ts` is one of the two guards holding the
 * PUBLISHED contract System 7 reads, and it enumerates the three places an
 * app event may be announced from — «An event announced from a fourth place
 * is an event nobody wrote the data contract for». AGENTS.md makes the
 * events contract a STOP-and-ask. Widening that guard to pass this change
 * would be an agent marking its own homework on the one contract the owner
 * singled out, so the gap is reported instead and recorded in
 * BACKLOG_P2.md.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('the event it does not announce, and why', () => {
  it('emits nothing — the three announced sites are still three', () => {
    for (const file of [...ROUTES, ...LIBS]) {
      expect(read(join(ROOT, file)), file).not.toMatch(/emitAppEvent\s*\(/);
    }
  });

  it('and the reason is written where the call would have gone', () => {
    // A blank space where a call belongs is how the next reader adds it
    // without knowing it was refused.
    const raw = readFileSync(join(ROOT, 'src/lib/v1/order-intake.ts'), 'utf8');
    expect(raw).toMatch(/NO `order\.created` IS ANNOUNCED FROM HERE/);
    expect(raw).toMatch(/events-sites\.test\.ts/);
  });

  it('and the five events that describe what happens next are untouched', () => {
    // `order.confirmed`, `order.shipped`, `order.delivered`, `order.returned`
    // and `order.cancelled` all still fire from the two state doors, so an
    // order raised through this door is followed exactly like any other.
    const confirmation = read(join(ROOT, 'src/app/api/orders/[id]/confirmation/route.ts'));
    const shipping = read(join(ROOT, 'src/app/api/orders/[id]/shipping/route.ts'));
    expect(confirmation).toMatch(/emitAppEvent\(/);
    expect(shipping).toMatch(/emitAppEvent\(/);
  });
});
