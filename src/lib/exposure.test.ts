import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CUSTOMER_FIELDS,
  IDLE_LIMIT_MS,
  IDLE_WARN_MS,
  idleState,
  secondsLeft,
  watermarkText,
} from './exposure';

/**
 * These are the rules for a system opened on staff-owned phones. None of
 * them prevents a screenshot — nothing can — and no test here pretends
 * otherwise. What they pin down is the part that IS achievable and that
 * quietly rots the moment nobody is watching it.
 */

describe('a screen left untouched', () => {
  const T0 = 1_700_000_000_000;

  it('is active while somebody is working', () => {
    expect(idleState(T0, T0)).toBe('active');
    expect(idleState(T0, T0 + IDLE_LIMIT_MS - IDLE_WARN_MS - 1)).toBe('active');
  });

  it('warns before it acts, never after', () => {
    expect(idleState(T0, T0 + IDLE_LIMIT_MS - IDLE_WARN_MS)).toBe('warning');
    expect(idleState(T0, T0 + IDLE_LIMIT_MS - 1)).toBe('warning');
  });

  it('expires exactly on the limit', () => {
    expect(idleState(T0, T0 + IDLE_LIMIT_MS)).toBe('expired');
    expect(idleState(T0, T0 + IDLE_LIMIT_MS * 10)).toBe('expired');
  });

  it('and NEVER expires because a clock moved backwards', () => {
    // A device correcting its time, or a tab restored from the back/forward
    // cache, produces a negative interval. Reading that as "twenty minutes
    // have passed" signs somebody out in the middle of a call, for a reason
    // nobody can explain, which is how a safety measure gets switched off.
    expect(idleState(T0, T0 - 60_000)).toBe('active');
    expect(idleState(T0, 0)).toBe('active');
  });

  it('counts down in whole seconds and never below zero', () => {
    expect(secondsLeft(T0, T0)).toBe(IDLE_LIMIT_MS / 1000);
    expect(secondsLeft(T0, T0 + IDLE_LIMIT_MS - 30_000)).toBe(30);
    expect(secondsLeft(T0, T0 + IDLE_LIMIT_MS + 999_999)).toBe(0);
  });

  it('gives a warning long enough to reach for the phone', () => {
    // A three-second warning is not a warning.
    expect(IDLE_WARN_MS).toBeGreaterThanOrEqual(30_000);
    expect(IDLE_LIMIT_MS).toBeGreaterThan(IDLE_WARN_MS);
  });
});

describe('the mark a photograph will carry', () => {
  const viewer = { name: 'أحمد المصري', id: '3f2a1b9c-77d4-4e51-9a02-abc123def456' };
  const at = new Date(2026, 8, 26, 14, 5);

  it('names the account that was looking', () => {
    expect(watermarkText(viewer, at)).toContain('أحمد المصري');
  });

  it('separates two people with the same name', () => {
    const twin = { name: 'أحمد المصري', id: '0000000-1111-2222-3333-999888777666' };
    expect(watermarkText(viewer, at)).not.toBe(watermarkText(twin, at));
  });

  it('and says when, so a leak can be placed in a shift', () => {
    expect(watermarkText(viewer, at)).toContain('2026-09-26 14:05');
  });

  /**
   * The guard that matters more than the feature. A watermark sits on the
   * screen all day, in front of whoever is standing behind the person.
   */
  it('carries nothing that would itself be worth leaking', () => {
    const text = watermarkText({ ...viewer, name: 'أحمد المصري' }, at);
    expect(text).not.toContain('@');
    // Not the whole account id either — a screen-readable primary key is a
    // gift to anybody assembling a picture of the company from photographs.
    expect(text).not.toContain(viewer.id);
    expect(text.length).toBeLessThan(60);
  });

  it('survives an account with no name rather than printing "undefined"', () => {
    expect(watermarkText({ name: '', id: viewer.id }, at)).toContain('مستخدم');
  });
});

/**
 * NOTHING OF THE CUSTOMER'S IN THE BROWSER'S OWN MEMORY.
 *
 * Client storage on a personal device outlives the session, survives
 * signing out, and is readable by anything else running on that device.
 * The rule is therefore absolute rather than careful, and a rule that is
 * only written down is a rule for as long as the person who wrote it stays.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/** Every `x.setItem(key, value)` in the codebase, with the file it is in. */
function storageWrites(): { file: string; value: string }[] {
  const found: { file: string; value: string }[] = [];
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:local|session)Storage\s*\.\s*setItem\s*\(([^;]*?)\)\s*;/g)) {
      found.push({ file: file.split(/[\\/]/).slice(-2).join('/'), value: m[1] });
    }
  }
  return found;
}

describe('what the browser is allowed to remember', () => {
  /**
   * One line per place that writes to storage, and a reason. A new entry
   * here is a deliberate act; that is the entire point of the list.
   */
  const ALLOWED: Record<string, string> = {
    'ai/AiDock.tsx': 'the assistant conversation — aggregates only, session storage, gone on reload',
    'labels/LabelSize.tsx': 'the paper loaded in this device’s printer',
    'shell/FirstRunTour.tsx': 'whether «تخطّي» was pressed on the first-run tour — a flag keyed by user id, session storage, gone with the tab',
    /*
     * THIS ENTRY LEFT ON THIS BRANCH AND CAME BACK, AND THAT IS THE RIGHT
     * ANSWER.
     *
     * The per-visitor timer keeps «when this visitor's countdown started» in
     * their browser so a reload cannot hand out a fresh deadline. This
     * branch read «عدّاد فقط من تاريخ انتهاء عرض حقيقي» as «take the timer
     * away», and with it gone there was nothing to remember.
     *
     * S6 landed first with the owner's own D8 and a better answer: the
     * per-visitor timer STAYS, the editor makes the seller choose it by
     * name, it carries its warning out loud, and «تلقائي» — bound to
     * `Offer.endsAt`, one moment for every visitor and nothing stored — is
     * refused at the save door when there is no ending to read. A seller
     * who chooses the honest clock stores nothing; one who chooses the
     * per-visitor one is told what it is.
     */
    'blocks/Countdown.tsx': 'when a public page’s per-visitor countdown started, for that visitor',
    'landing/OrderForm.tsx': 'which campaign a visitor arrived from',
    'shell/Sidebar.tsx': 'which menu groups this person leaves open',
    'growth/CampaignsBoard.tsx': 'which of the three campaign views this person last picked — a word, never a record',
    'shell/IdleGuard.tsx': 'a timestamp, shared between this account’s open tabs',
    'shell/InstallApp.tsx': 'when «ليس الآن» was pressed on the install strip — a timestamp, nothing about a person or a record',
    'ui/SavedViews.tsx': 'a name and a query string — a question to re-ask, never an answer or a record id',
    'storefront/RecentlyViewed.tsx':
      'a shopper’s own «شوهد مؤخراً» — product ids, one key per shop. Never sent anywhere except to ask what those products are, never stored against a person, and nothing in it names one',
    'storefront/useCart.ts':
      'a shopper’s basket — product ids, offer ids and counts, one key per shop. No price, because a price in a browser is a price a browser can edit; and no name, phone or address, which is what the test below proves rather than what this line promises',
    /*
     * THE BASKET'S ANSWER, FOR ITS THANK-YOU PAGE (RV250).
     *
     * The add-on token is in it, and that is the point of the entry rather
     * than an accident of it: the token is the customer's own thirty-minute
     * capability for their own order, which the landing form has always held
     * in memory on the same screen. The basket's thank-you screen is another
     * page, so the answer crosses one navigation — in session storage, this
     * tab only, never in the link — and is removed once the card is answered
     * or its window has passed. What the entry holds is pinned, key by key,
     * in `the-cart-order-is-offered-the-after-order-offer.test.tsx`.
     */
    'storefront/after-order-handoff.ts':
      'the basket’s order answer for its own thank-you page — the reference, the add-on token, the server’s one offer after the order, its window, the currency and its decimals, and when it arrived. Session storage, one key per order, gone once the card is answered or the window has passed; no name, phone or address',
  };

  it('writes to storage only in the places that were thought about', () => {
    const files = [...new Set(storageWrites().map((w) => w.file))].sort();
    expect(files, 'مكان جديد يكتب في ذاكرة المتصفح — أضفه للقائمة بسبب مكتوب').toEqual(
      Object.keys(ALLOWED).sort()
    );
  });

  it('and never writes a customer’s name, phone or address into it', () => {
    const offenders: string[] = [];
    for (const { file, value } of storageWrites()) {
      for (const field of CUSTOMER_FIELDS) {
        // The VALUE being written, not the file: a screen may hold a phone
        // number on screen all day. What it may not do is persist one.
        if (new RegExp(`\\b${field}\\b`).test(value)) offenders.push(`${file}: ${field}`);
      }
    }
    expect(offenders, `بيانات عميل في ذاكرة المتصفح:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and no part of the app reaches for IndexedDB, which nothing here needs', () => {
    const users = sourceFiles(join(process.cwd(), 'src'))
      .filter((f) => /\bindexedDB\b/.test(readFileSync(f, 'utf8')))
      .map((f) => f.split(/[\\/]/).slice(-2).join('/'));
    expect(users).toEqual([]);
  });
});

/**
 * THE WORKER, AGAIN, FROM THIS ANGLE.
 *
 * A cache is client storage too, and a cached API response is a copy of a
 * customer list sitting on a phone after the person has signed out.
 */
describe('the service worker keeps no copy of anything read', () => {
  const sw = () => readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

  it('never caches an API response', () => {
    const src = sw();
    // The promise is kept by ORDER, not by intention: the worker hands an
    // API request back to the browser before any line that could respond to
    // it or store it. So that is what is checked — that the bail comes
    // first, rather than that some regex for caching is absent.
    const bail = src.indexOf("url.pathname.startsWith('/api/')");
    expect(bail, 'العامل لم يعد يتنحّى عن مسارات الـAPI').toBeGreaterThan(-1);
    expect(src.slice(bail, bail + 80)).toContain('return');

    const firstRespond = src.indexOf('event.respondWith');
    const firstCache = src.indexOf('caches.', src.indexOf(`addEventListener('fetch'`));
    expect(bail).toBeLessThan(firstRespond);
    expect(bail).toBeLessThan(firstCache);
  });

  it('and still refuses to touch anything that changes data', () => {
    expect(sw()).toContain("request.method !== 'GET'");
  });
});
