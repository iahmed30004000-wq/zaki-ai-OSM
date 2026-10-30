import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dashboardFiles, repoFile, stripComments } from './guard-source';
import { waNumber, whatsappLink, whatsappReady } from './message-templates';

/**
 * DEFINITION OF DONE
 *
 * 1. The «لا يرد» list of the confirmation desk (and every other list that draws the contact strip) hands the strip
 *    the country's calling code, so «0952554562» opens +963 952 554 562 and not +95 (Myanmar).
 * 2. A local number with a leading zero and NO country code never becomes a WhatsApp link: `waNumber` answers
 *    nothing and the strip shuts the button and says why. A number that carries its own country is untouched.
 * 3. No screen can draw `<ContactButtons>` without the code again: the guard at the bottom fails the build.
 * 4. The message that goes with the link (name, product, address) is not touched.
 *
 * The cause: the desk's response carried no calling code, the screen passed none, and `waNumber` left «0952…» as
 * it was; wa.me drops the zero and reads «95…» as a country.
 */

describe('waNumber — a local number is made international by the store’s country', () => {
  it('Syria: 0952554562 + 963 → 963952554562', () => {
    expect(waNumber('0952554562', '963')).toBe('963952554562');
  });

  it('Jordan: 0791234567 + 962 → 962791234567', () => {
    expect(waNumber('0791234567', '962')).toBe('962791234567');
  });

  it('a number that already starts with the country is not doubled', () => {
    expect(waNumber('963952554562', '963')).toBe('963952554562');
    expect(waNumber('+963 952 554 562', '963')).toBe('963952554562');
    // a short country code: Egypt
    expect(waNumber('201012345678', '20')).toBe('201012345678');
  });

  it('a full international number passes as it is, with or without a country', () => {
    expect(waNumber('905321234567')).toBe('905321234567');
    expect(waNumber('905321234567', '963')).toBe('905321234567');
    expect(waNumber('+905321234567')).toBe('905321234567');
  });

  it('«00…» is international and loses the 00', () => {
    expect(waNumber('00905321234567')).toBe('905321234567');
    expect(waNumber('00963952554562', '962')).toBe('963952554562');
  });

  it('a «+» typed in front keeps a short international number too (no country needed)', () => {
    expect(waNumber('+47 12345678')).toBe('4712345678');
  });
});

describe('waNumber — a local number with no country is NOT a number', () => {
  it('the exact fault: 0952554562 with no code used to stay «0952554562» and wa.me read +95', () => {
    expect(waNumber('0952554562')).toBe('');
    expect(waNumber('0952554562', null)).toBe('');
    expect(waNumber('0952554562', '')).toBe('');
    expect(waNumber('0952554562', '   ')).toBe('');
  });

  it('Jordan’s 079… with no code is not a number either', () => {
    expect(waNumber('0791234567')).toBe('');
  });

  it('nor is a local number written without its zero', () => {
    expect(waNumber('952554562')).toBe('');
  });

  it('whatsappLink gives no link, with or without a message', () => {
    expect(whatsappLink('0952554562')).toBe('');
    expect(whatsappLink('0952554562', undefined, 'نريد تأكيد العنوان')).toBe('');
    expect(whatsappLink('0952554562', null, 'نريد تأكيد العنوان')).toBe('');
  });

  it('and with the code, the message rides on the link untouched', () => {
    const text = 'مرحباً أبو محمد، نريد تأكيد العنوان';
    expect(whatsappLink('0952554562', '963', text)).toBe(`https://wa.me/963952554562?text=${encodeURIComponent(text)}`);
  });

  it('whatsappReady says the same in one word', () => {
    expect(whatsappReady('0952554562', '963')).toBe(true);
    expect(whatsappReady('0952554562', null)).toBe(false);
    expect(whatsappReady('0952554562')).toBe(false);
    expect(whatsappReady('905321234567')).toBe(true);
    expect(whatsappReady(null, '963')).toBe(false);
    expect(whatsappReady('—', '963')).toBe(false);
  });
});

describe('the doors that feed a contact strip send the calling code', () => {
  it.each([
    'src/app/api/confirmation/mine/route.ts',
    'src/app/api/delivery-providers/route.ts',
  ])('%s — from the store’s country, never a literal', (rel) => {
    const src = stripComments(repoFile(rel));
    expect(src, `${rel}: القائمة بلا رمز اتّصال`).toMatch(/dialCode:\s*ruleFor\(country\.code\)\?\.dialCode \?\? null/);
    expect(src, `${rel}: رمز مكتوب بيد`).not.toMatch(/dialCode:\s*['"]\d+['"]/);
  });
});

/**
 * NO SCREEN DRAWS THE STRIP WITHOUT THE CODE.
 *
 * The allowlist is empty on purpose. A screen that truly has no country to give (it does not exist today) goes here
 * with the reason beside it, and the strip then shuts WhatsApp for any local number it shows.
 */
const NO_COUNTRY_ALLOWED: Record<string, string> = {};

describe('every <ContactButtons> on a screen is given the country', () => {
  const calls: { rel: string; call: string; fileBody: string }[] = [];
  for (const { rel, src } of dashboardFiles('both')) {
    if (rel.endsWith('/ContactButtons.tsx')) continue;
    const body = stripComments(src);
    let at = body.indexOf('<ContactButtons');
    while (at !== -1) {
      const end = body.indexOf('/>', at);
      calls.push({ rel, call: body.slice(at, end === -1 ? undefined : end), fileBody: body });
      at = body.indexOf('<ContactButtons', at + 1);
    }
  }

  it('the screens that draw it are found (the guard is not looking at nothing)', () => {
    const files = new Set(calls.map((c) => c.rel));
    for (const name of ['ConfirmationMineScreen', 'OrdersScreen', 'CustomersScreen', 'TrackingScreen', 'CouriersScreen', 'CustomerCard']) {
      expect([...files].some((f) => f.includes(name)), `${name}: ما لقى الحارس الشريط فيها`).toBe(true);
    }
  });

  it('and each carries countryCode — directly, or through a spread whose source names it', () => {
    const missing = calls
      .filter(({ rel }) => !(rel in NO_COUNTRY_ALLOWED))
      .filter(({ call, fileBody }) => {
        if (/countryCode\s*=/.test(call)) return false;
        // `{...contactFor(o)}` — the helper builds the props, and has to name the code.
        if (call.includes('{...') && /countryCode:/.test(fileBody)) return false;
        return true;
      })
      .map(({ rel }) => rel);
    expect(missing, `شريط اتصال بلا رمز دولة:\n${missing.join('\n')}`).toEqual([]);
  });

  it('and «لا يرد» in particular passes the one the desk was sent', () => {
    const screen = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    const from = screen.indexOf('<ContactButtons');
    const call = screen.slice(from, screen.indexOf('/>', from));
    expect(call).toContain('countryCode={data.dialCode}');
  });
});

describe('Arabic-Indic and Persian digits are read as digits', () => {
  it('٠٩٥٢٥٥٤٥٦٢ + 963 → 963952554562', () => {
    expect(waNumber('٠٩٥٢٥٥٤٥٦٢', '963')).toBe('963952554562');
  });

  it('Persian digits too, and mixed with Latin ones', () => {
    expect(waNumber('۰۹۵۲۵۵۴۵۶۲', '963')).toBe('963952554562');
    expect(waNumber('٠952554562', '963')).toBe('963952554562');
  });

  it('without a country they are a local number all the same — shut, for the right reason', () => {
    expect(waNumber('٠٩٥٢٥٥٤٥٦٢')).toBe('');
    expect(waNumber('٠٠٩٠٥٣٢١٢٣٤٥٦٧')).toBe('905321234567');
  });
});

describe('the courier’s office gets the country too', () => {
  it('the change-requests list sends the calling code, from the store’s country', () => {
    const src = stripComments(repoFile('src/app/api/control/change-requests/route.ts'));
    expect(src).toMatch(/dialCode:\s*ruleFor\(country\.code\)\?\.dialCode \?\? null/);
  });

  it('and the screen hands it to the dialog', () => {
    const src = stripComments(repoFile('src/components/screens/ChangeRequestsScreen.tsx'));
    const from = src.indexOf('<CourierNotifyDialog');
    expect(src.slice(from, src.indexOf('/>', from))).toContain('countryCode={dialCode}');
  });

  it('and the dialog shuts the button and claims «sent» only for a link that opened', () => {
    const src = stripComments(repoFile('src/components/orders/CourierNotifyDialog.tsx'));
    expect(src).toContain('whatsappReady(phone, countryCode)');
    expect(src).toContain('disabled={!waReady}');
    expect(src).toMatch(/if \(!link\) return;/);
  });
});

/**
 * NO ONE BUILDS A WHATSAPP LINK WITHOUT SAYING WHICH COUNTRY.
 *
 * Every caller of `whatsappLink(` outside its own file passes `countryCode` or `dialCode` as the second argument. A
 * caller that leaves it out gets an empty link for a local number — and a dialog that did not look at the result
 * opened a blank tab and called the message sent.
 */
describe('every whatsappLink caller names the country', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules') continue;
        walk(full, out);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  };

  const callers: { file: string; call: string }[] = [];
  for (const file of walk(join(process.cwd(), 'src'))) {
    if (file.endsWith('message-templates.ts')) continue;
    const body = stripComments(readFileSync(file, 'utf8'));
    for (const m of body.matchAll(/whatsappLink\(([^)]*)\)/g)) callers.push({ file, call: m[1] ?? '' });
  }

  it('the callers are found (the guard is not looking at nothing)', () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it('and each passes countryCode or dialCode second', () => {
    const bad = callers.filter(({ call }) => !/^[^,]+,\s*(countryCode|dialCode)\b/.test(call)).map((c) => `${c.file}: whatsappLink(${c.call})`);
    expect(bad, `رابط واتساب بلا رمز دولة:\n${bad.join('\n')}`).toEqual([]);
  });
});
