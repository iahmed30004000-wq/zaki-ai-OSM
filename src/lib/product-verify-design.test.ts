import { describe, expect, it } from 'vitest';
import {
  RESERVED_SLUGS,
  isDarkColor,
  normalizeSlug,
  normalizeWhatsapp,
  productVerifyLink,
  slugProblem,
  slugify,
  suggestSlug,
  contactWhatsappUrl,
} from './product-verify-design';

/**
 * «باركود المنتجات» — the short link's rules (25/11, owner: «الروابط بكون بقدر اعدل عليها واخليها اقصر»), read by the
 * editor as the owner types and by the server on every save.
 */

describe('a short link is lowercase latin, digits and single inner dashes, 3–40 long', () => {
  it.each(['krem', 'krem-1', 'a1b', 'zaki-oud-100ml', 'x'.repeat(40)])('%s is accepted', (s) => {
    expect(slugProblem(s)).toBeNull();
  });

  it.each([
    ['ab', 'قصير'],
    ['x'.repeat(41), 'طويل'],
    ['-krem', 'شرطة'],
    ['krem-', 'شرطة'],
    ['krem--1', 'شرطة'],
    ['Krem', 'إنكليزية صغيرة'],
    ['كريم', 'إنكليزية صغيرة'],
    ['krem 1', 'إنكليزية صغيرة'],
    ['krem_1', 'إنكليزية صغيرة'],
    ['krem/1', 'إنكليزية صغيرة'],
  ])('NEGATIVE: %s is refused, in Arabic', (s, word) => {
    expect(slugProblem(s)).toContain(word);
  });

  it('what the owner types is trimmed and lowercased before it is judged', () => {
    expect(normalizeSlug('  Krem-1 ')).toBe('krem-1');
    expect(slugProblem(normalizeSlug('  Krem-1 '))).toBeNull();
  });

  it('NEGATIVE: the reserved words are never a product link', () => {
    for (const w of ['admin', 'api', 'verify', 'login', 'settings', 'new']) {
      expect(RESERVED_SLUGS).toContain(w);
      expect(slugProblem(w), w).toBe('هالكلمة محجوزة للنظام — اختار رابط تاني');
    }
  });
});

describe('the suggestion comes from the product', () => {
  it('the English name first', () => {
    expect(suggestSlug({ name: 'كريم الأذن', nameEn: 'Ear Cream 50ml', sku: 'EAR-01' })).toBe('ear-cream-50ml');
  });

  it('else the Arabic name, transliterated', () => {
    expect(suggestSlug({ name: 'كريم الأذن', nameEn: null, sku: 'EAR-01' })).toBe('krym-alathn');
    expect(slugify('عطر ٣')).toBe('atr-3');
  });

  it('else the SKU; and null when nothing makes a valid one (the server then draws a random one)', () => {
    expect(suggestSlug({ name: '✓✓', nameEn: null, sku: 'P-0042' })).toBe('p-0042');
    expect(suggestSlug({ name: '✓', nameEn: '', sku: '!' })).toBeNull();
  });

  it('a long name is cut at a word, never past 32', () => {
    const s = slugify('the very long name of a product that never ends at all');
    expect(s.length).toBeLessThanOrEqual(32);
    expect(s.endsWith('-')).toBe(false);
    expect(slugProblem(s)).toBeNull();
  });
});

describe('the links', () => {
  it('the product barcode is /v/<slug>; a piece is the same with ?code=', () => {
    expect(productVerifyLink('https://crm.example', 'krem')).toBe('https://crm.example/v/krem');
    expect(productVerifyLink('https://crm.example', 'krem', 'P 7&x')).toBe('https://crm.example/v/krem?code=P%207%26x');
  });

  it('WhatsApp: digits with the country code, or nothing', () => {
    expect(normalizeWhatsapp('+963 912-345-678')).toBe('963912345678');
    expect(normalizeWhatsapp('00963912345678')).toBe('963912345678');
    expect(normalizeWhatsapp('12')).toBeNull();
    expect(normalizeWhatsapp('abc')).toBeNull();
    expect(contactWhatsappUrl('963912345678', 'عطر')).toMatch(/^https:\/\/wa\.me\/963912345678\?text=/);
    expect(contactWhatsappUrl(null, 'عطر')).toBeNull();
  });

  it('a dark colour gets light text', () => {
    expect(isDarkColor('#050912')).toBe(true);
    expect(isDarkColor('#f5f7fb')).toBe(false);
    expect(isDarkColor('not-a-colour')).toBe(false);
  });
});
