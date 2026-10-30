import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoFile, stripComments } from './guard-source';
import { tierFor } from './customer-risk';

/**
 * تشطيب ١ — STAGE 1: THE COMMITMENTS LEDGER, the customer section.
 *
 * «Customer is company-wide: one phone, one person, one risk history…
 *  Blacklist and duplicate detection are company-wide, never country-scoped.
 *  Country is determined by the DELIVERY ADDRESS, never the phone prefix.»
 *
 * The risk tiers hold exactly. The identity is scoped differently from the
 * wording and the reason is written in the schema. Two halves are NOT built,
 * and they are pinned as not built rather than described as done.
 */

describe('1 · the risk tiers are the contract’s numbers', () => {
  it('under 15% is safe', () => {
    expect(tierFor(0.149, 10, 0)).toBe('SAFE');
    expect(tierFor(0, 0, 0)).toBe('SAFE');
  });

  it('15% to 40% is watch', () => {
    expect(tierFor(0.15, 10, 0)).toBe('WATCH');
    expect(tierFor(0.4, 10, 0)).toBe('WATCH');
  });

  it('above 40% with three orders or more is high', () => {
    expect(tierFor(0.41, 3, 0)).toBe('HIGH');
  });

  it('but above 40% on one or two orders is NOT high', () => {
    // One return out of two is 50% and says almost nothing. Calling it high
    // risk on a sample of two is how a new customer is refused COD.
    expect(tierFor(0.5, 2, 0)).toBe('WATCH');
    expect(tierFor(1, 1, 0)).toBe('WATCH');
  });

  it('and two returns inside sixty days is high however good the rate', () => {
    // A customer with fifty clean orders who returns two this month is a
    // customer something changed about.
    expect(tierFor(0.04, 50, 2)).toBe('HIGH');
  });

  it('and one return inside sixty days is not', () => {
    expect(tierFor(0.04, 50, 1)).toBe('SAFE');
  });
});

describe('2 · the window is six months OR the last ten orders', () => {
  const src = stripComments(repoFile('src/lib/customer-risk.ts'));

  it('both are read, and the one holding more orders wins', () => {
    expect(src).toMatch(/const window = sixMonths\.length >= lastTen\.length \? sixMonths : lastTen;/);
    expect(src).toMatch(/take: 10,/);
  });

  it('and six months is 182 days, not a month count that drifts', () => {
    expect(src).toMatch(/const SIX_MONTHS_MS = 182 \* 24 \* 60 \* 60 \* 1000;/);
    expect(src).toMatch(/const SIXTY_DAYS_MS = 60 \* 24 \* 60 \* 60 \* 1000;/);
  });

  it('and a failed delivery counts as a return, because the parcel came back', () => {
    expect(src).toMatch(/RETURNED_STATUSES = \['RETURNED', 'RETURN_REQUESTED', 'FAILED_DELIVERY'\]/);
  });

  it('and the 60-day clock runs from when it came back, not when it was ordered', () => {
    // `returnedAt ?? createdAt`: an order placed in March and returned in
    // September is a September return.
    expect(src).toMatch(/new Date\(o\.returnedAt \?\? o\.createdAt\)/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 3 · «one phone, one person, one RISK HISTORY» — the history now holds; the
 * customer ROW is deliberately per store.
 *
 * `@@unique([companyId, storeId, phone])`, and the schema says why in its own
 * words: «The stores are separate businesses: the same customer may buy from
 * two of them, and each keeps its own record and its own history.»
 *
 * But the RISK is not a record, it is a judgement about a person — and it was
 * computed by `customerId`, which made it per store. A customer who returned
 * six of ten parcels at one shop arrived SAFE at the shop next door. The
 * system had already ruled the identical question for the blacklist, in the
 * schema's own words: «a blocked number that can order from the shop next
 * door blocks nothing.» Fixed 2026-10-02: the risk, and the history the
 * assistant is shown beside it, are both read by PHONE across the company.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('3 · the person is one person, across the stores', () => {
  it('the customer row is per store, and the schema says why', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model Customer {'));
    const body = m.slice(0, m.indexOf('\n}'));
    expect(body).toMatch(/@@unique\(\[companyId, storeId, phone\]\)/);
    expect(body).toMatch(/The stores are separate businesses/);
    // And the phone is indexed company-wide, which is what makes the
    // cross-store question answerable at all.
    expect(body).toMatch(/@@index\(\[companyId, phone\]\)/);
  });

  it('and the «same person» clause is read by PHONE, in ONE place', () => {
    const src = stripComments(repoFile('src/lib/customer-risk.ts'));
    expect(src).toMatch(/return me\?\.phone \? \{ customer: \{ phone: me\.phone \} \} : \{ customerId \};/);
    // One resolver, two readers. Two copies of this clause is two answers to
    // «who is this person» the first time one of them is edited.
    expect([...src.matchAll(/samePerson\(tx, companyId, customerId\)/g)].length).toBe(2);
    expect([...src.matchAll(/\.\.\.whose/g)].length).toBe(3);
  });

  it('and both risk windows use it, or they answer about different people', () => {
    const src = stripComments(repoFile('src/lib/customer-risk.ts'));
    const fn = src.slice(src.indexOf('export async function customerRisk('));
    const body = fn.slice(0, fn.indexOf('\n  const window'));
    expect([...body.matchAll(/\.\.\.whose/g)].length).toBe(2);
  });

  it('and the history shown beside the tier is the same person’s', () => {
    const route = stripComments(repoFile('src/app/api/ai/confirmation/route.ts'));
    expect(route).toMatch(/customerHistory\(db, companyId, order\.customer\.id, \{ exceptOrderId: order\.id \}\)/);
  });

  it('and the assistant’s route still never selects a phone at all', () => {
    /*
     * This is why the resolver lives in `customer-risk.ts`. The route sends
     * text to a model, so the standing rule is that the number does not enter
     * the process — not merely that it stays out of the payload. Reading it
     * here to find the person would have weakened a guard that was right.
     */
    const route = stripComments(repoFile('src/app/api/ai/confirmation/route.ts'));
    expect(route).not.toMatch(/phone/);
  });

  it('and the blacklist is company-wide by phone, with no store in the question', () => {
    const bl = stripComments(repoFile('src/lib/blacklist.ts'));
    const fn = bl.slice(bl.indexOf('export async function activeBlock('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/where: \{ companyId, phone: \{ in: keys \}, releasedAt: null \}/);
    expect(body).not.toMatch(/storeId/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 4 · «Country is determined by the DELIVERY ADDRESS, never the phone
 * prefix.» — HELD, and by validation rather than by a warning.
 *
 * The order's country is the STORE's, and the regions the form will accept
 * are the regions OF THAT COUNTRY — so the address and the country cannot
 * disagree. The phone is then validated AGAINST the country: the country
 * decides the phone rule, never the reverse.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('4 · the country comes from the address, never from the number', () => {
  const src = stripComments(repoFile('src/lib/public-order.ts'));

  it('the accepted regions are the store country’s, read from the database', () => {
    expect(src).toMatch(/where: \{ countryId: store\.countryId, isActive: true \}/);
  });

  it('and they are a VALIDATION, not a list the form happens to show', () => {
    expect(src).toMatch(/buildPublicOrderSchema\(\{/);
    expect(src).toMatch(/regions: regions\.map\(\(r\) => r\.name\)/);
    expect(src).toMatch(/if \(!parsed\.success\)/);
  });

  it('and the phone rule is chosen BY the country, not the country by the phone', () => {
    expect(src).toMatch(/countryCode: store\.country\.code/);
  });

  it('and a region belongs to exactly one country', () => {
    const schema = repoFile('prisma/schema.prisma');
    const m = schema.slice(schema.indexOf('model Region {'));
    const body = m.slice(0, m.indexOf('\n}'));
    expect(body).toMatch(/countryId String\b/);
    expect(body).toMatch(/@@unique\(\[countryId, name\]\)/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * NOT BUILT — pinned as not built, because a flag that reads as enforcement
 * is worse than an absence somebody can see.
 *
 * 5 · «CustomerMarket holds per-country activity.» There is no such model.
 *     The per-store customer row IS the per-market record, since
 *     `Store.countryId` is required — so the activity is held, under another
 *     name and one level down.
 *
 * 6 · «High risk requires prepayment or supervisor approval.» NOTHING
 *     refuses. The tier reaches the assistant as context and the screens as a
 *     chip. Building the refusal means deciding what counts as approval and
 *     which role may give it — the owner's to say, not a detector's.
 *
 * 7 · «excluded from automated confirmation» has nothing to exclude from: no
 *     job confirms orders. Vacuous, not violated.
 *
 * 8 · «duplicate detection» is not a detector. `DUPLICATE_ORDER` is a
 *     rejection REASON an agent picks after speaking to the customer, and the
 *     Telegram `DUPLICATE` is the same MESSAGE arriving twice — a different
 *     thing at a different layer. Nothing compares a new order against the
 *     customer's open ones.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('what is NOT built, pinned so it cannot read as done', () => {
  it('there is no CustomerMarket model, and the store carries the country instead', () => {
    const schema = repoFile('prisma/schema.prisma');
    expect(schema).not.toMatch(/model CustomerMarket \{/);
    const store = schema.slice(schema.indexOf('model Store {'));
    expect(store.slice(0, store.indexOf('\n}'))).toMatch(/countryId\s+String\s*$/m);
  });

  it('no door refuses a confirmation on the risk tier', () => {
    // The day one does, this fails and the ledger entry is rewritten.
    for (const door of [
      'src/app/api/orders/[id]/confirmation/route.ts',
      'src/app/api/confirmation/mine/route.ts',
    ]) {
      const src = stripComments(repoFile(door));
      expect(src, door).not.toMatch(/requiresPrepaymentOrApproval/);
    }
  });

  it('and no job confirms an order, so there is nothing to exclude', () => {
    // every job, now that each one has its own file
    const folder = 'src/lib/jobs/definitions';
    const jobs = stripComments(
      readdirSync(join(process.cwd(), folder))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => repoFile(`${folder}/${f}`))
        .join('\n')
    );
    expect(jobs).not.toMatch(/confirmationStatus: 'CONFIRMED'/);
    expect(jobs).not.toMatch(/excludedFromAutomatedConfirmation/);
  });

  it('and the module says plainly which of its flags are advice', () => {
    // The comment used to claim «the API says so, the UI only renders it».
    // It did not say so. A false claim of enforcement is why nobody looks.
    const doc = repoFile('src/lib/customer-risk.ts');
    expect(doc).not.toMatch(/the API says so, the UI only renders it/);
    expect(doc).toMatch(/is ADVICE/);
    expect(doc).toMatch(/has nothing to exclude from/);
  });

  it('and no ORDER-level duplicate detector exists — the reason is a verdict', () => {
    // `DUPLICATE_ORDER` lives in the REJECTION_REASONS vocabulary, beside the
    // other things a person concludes after a phone call. Nothing compares a
    // new order against the customer's open ones.
    const wf = stripComments(repoFile('src/lib/confirmation-workflow.ts'));
    expect(wf).toMatch(/'DUPLICATE_ORDER', 'WRONG_NUMBER', 'FAKE_ORDER'/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * RECORDS SPLIT, JUDGEMENTS DO NOT.
 *
 * The contract puts «blacklist and duplicate detection» in one sentence and
 * asks for both company-wide. The system's answer is sharper, and it is
 * written in two modules independently:
 *
 *   · the customer RECORD is per store, because «one shared row would put
 *     one store's complaint on the other's screen» (`customer-identity.ts`);
 *   · a judgement ABOUT THE PERSON is company-wide — the blacklist always
 *     was, and the risk is as of 2026-10-02.
 *
 * Duplicate-CUSTOMER detection therefore exists and is store-scoped on
 * purpose: `findOrCreateCustomer`, with the unique index as the arbiter of
 * the race rather than a prior read.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('duplicate customers are detected, per store, by the index', () => {
  const id = stripComments(repoFile('src/lib/customer-identity.ts'));

  it('the phone is the identity, and the lookup is scoped to the store', () => {
    expect(id).toMatch(/where: \{ companyId, storeId, phone \}/);
  });

  it('and the UNIQUE INDEX decides the race, not the read before it', () => {
    // Two people submitting the same number at the same moment is ordinary on
    // a landing page. The loser reads the winner's row instead of failing an
    // order the customer already believes they placed.
    expect(id).toMatch(/try \{/);
    expect(repoFile('src/lib/customer-identity.ts')).toMatch(/which\s+\*? ?is\s*\n?\s*\*? ?why the unique index is the thing relied on/);
  });

  it('and the FIVE doors its own comment names all come through it', () => {
    /*
     * «the customers screen, a manual order, a landing page submission, a
     * Telegram message and the AI intake» — five, and the Telegram one is in
     * `inbound.ts`, one hop above `order-creation.ts`. Looking for it in the
     * creator rather than the door is how the same file was wrongly reported
     * as skipping the blacklist earlier in this audit.
     */
    for (const door of [
      'src/app/api/customers/route.ts',
      'src/app/api/orders/route.ts',
      'src/lib/public-order.ts',
      'src/lib/telegram/inbound.ts',
      'src/app/api/orders/ai-intake/route.ts',
    ]) {
      expect(stripComments(repoFile(door)), door).toMatch(/findOrCreateCustomer\(/);
    }
  });

  it('and no door writes a customer without going through it', () => {
    /*
     * The customers screen IMPORTED the owner and never called it — the dead
     * import is what gave away three faults in its own `create`: no `storeId`
     * at all (so the unique index did not bind, because Postgres treats NULLs
     * as distinct, and the duplicate check could never find the row again), a
     * lost race on two clicks, and `city: 'Cairo'` / `country: 'Egypt'`
     * invented for a company whose stores are elsewhere — in a column that is
     * a two-letter code everywhere else.
     */
    for (const door of [
      'src/app/api/customers/route.ts',
      'src/app/api/orders/route.ts',
      'src/lib/public-order.ts',
      'src/lib/telegram/inbound.ts',
      'src/app/api/orders/ai-intake/route.ts',
    ]) {
      expect(stripComments(repoFile(door)), door).not.toMatch(/db\.customer\.create\(|tx\.customer\.create\(/);
    }
  });

  it('and nothing invents a city or a country for somebody', () => {
    const route = stripComments(repoFile('src/app/api/customers/route.ts'));
    expect(route).not.toMatch(/'Cairo'|'Egypt'/);
    // The country is the store's. This door does not read one from the body.
    const post = route.slice(route.indexOf('const { fullName'));
    expect(post.slice(0, post.indexOf('} = body;'))).not.toMatch(/country/);
  });

  it('and the module says why the record splits while the block does not', () => {
    const doc = repoFile('src/lib/customer-identity.ts');
    expect(doc).toMatch(/One shared row would put one store's complaint/);
    expect(doc).toMatch(/blocked number that can simply order from the store next door blocks\s*\n?\s*\*?\s*nothing/);
  });
});
