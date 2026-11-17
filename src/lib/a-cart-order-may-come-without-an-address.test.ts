import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildPublicOrderSchema } from './landing-order-schema';
import { repoFile, stripComments } from './guard-source';

/**
 * AN ORDER MAY COME WITHOUT AN ADDRESS — the order an abandoned cart becomes by itself, and nowhere else (the owner, 17/11).
 *
 * A cart is a visitor who typed a name and a phone and never pressed «اطلب»: there is no address to send. The owner
 * chose to put it in the queue anyway, with a history line telling the team to confirm the address and the governorate
 * on the call. So `addressOptional` exists — and, like `cityOptional` before it, one door sets it. Held here:
 *
 *   · with the option, a blank, missing or null address passes; an address that IS written keeps every rule, in the same
 *     words as before;
 *   · without it, a blank address is refused exactly as it was;
 *   · `addressOptional: true` is written in ONE function in the whole tree — `takeCartOrder` — and the engine reads it
 *     only as `surface.addressOptional === true`, so no other door gets it by default or by accident.
 */

const locale = { countryCode: 'JO', regions: ['عمّان'] };
const body = (over: Record<string, unknown> = {}) => ({ full_name: 'محمد', phone: '0791234567', address: '', city: 'عمّان', ...over });
const addressError = (addressOptional: boolean | undefined, sent: Record<string, unknown>) => {
  const r = buildPublicOrderSchema({ ...locale, ...(addressOptional === undefined ? {} : { addressOptional }) }).safeParse(sent);
  return r.success ? null : r.error.issues.find((i) => i.path[0] === 'address')?.message ?? null;
};

describe('with `addressOptional`, a blank address is an answer', () => {
  it.each([
    ['empty', body({ address: '' })],
    ['only spaces', body({ address: '   ' })],
    ['missing', (({ address: _a, ...rest }) => rest)(body())],
    ['null', body({ address: null })],
  ])('%s ⇒ accepted, as an empty address', (_name, sent) => {
    const r = buildPublicOrderSchema({ ...locale, addressOptional: true }).safeParse(sent);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(r.success && r.data.address).toBe('');
  });

  it('an address that is written keeps its rule and its words', () => {
    expect(addressError(true, body({ address: 'شا' }))).toBe('يرجى إدخال العنوان بشكل أوضح.');
    expect(addressError(true, body({ address: 'شا' }))).toBe(addressError(false, body({ address: 'شا' })));
    expect(addressError(true, body({ address: 'شارع الجامعة' }))).toBeNull();
  });
});

describe('NEGATIVE: every other door still asks for the address', () => {
  it.each([[undefined], [false]])('addressOptional %s ⇒ a blank address is refused', (flag) => {
    expect(addressError(flag as boolean | undefined, body({ address: '' }))).not.toBeNull();
    expect(addressError(flag as boolean | undefined, (({ address: _a, ...rest }) => rest)(body()))).not.toBeNull();
  });
});

describe('only the abandoned-cart order sets it', () => {
  const SRC = join(process.cwd(), 'src');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };

  it('`addressOptional: true` is written in one file of the tree, `v1/landing-door.ts`', () => {
    const hits = walk(SRC)
      .filter((p) => /addressOptional:\s*true/.test(stripComments(readFileSync(p, 'utf8'))))
      .map((p) => relative(process.cwd(), p).replace(/\\/g, '/'));
    expect(hits).toEqual(['src/lib/v1/landing-door.ts']);
  });

  it('…once, inside `takeCartOrder` — the visitor’s own door (`takeLandingOrder`) does not set it', () => {
    const src = stripComments(repoFile('src/lib/v1/landing-door.ts'));
    expect(src.match(/addressOptional:\s*true/g)).toHaveLength(1);
    const cartDoor = src.slice(src.indexOf('export async function takeCartOrder'));
    expect(cartDoor.slice(0, cartDoor.indexOf('\n}\n'))).toMatch(/addressOptional:\s*true/);
    const visitorDoor = src.slice(src.indexOf('export async function takeLandingOrder'));
    expect(visitorDoor.slice(0, visitorDoor.indexOf('\n}\n'))).not.toMatch(/addressOptional/);
  });

  it('the engine reads it only as a strict true, and hands it to the schema', () => {
    const src = stripComments(repoFile('src/lib/public-order.ts'));
    expect(src).toContain('addressOptional: surface.addressOptional === true');
  });
});
