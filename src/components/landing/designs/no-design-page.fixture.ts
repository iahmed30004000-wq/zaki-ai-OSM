import React from 'react';
import { newSection, type LandingSection } from '@/lib/landing-sections';
import { trustRow } from '@/lib/selling-blocks';
import type { BlockContext } from '../blocks/PageBlocks';

/**
 * THE PAGE THE «NO DESIGN» GOLDEN COPY IS DRAWN FROM.
 *
 * `__golden__/no-design.html` is this page rendered by `PageBlocks` on
 * `osm/main` BEFORE any design code existed (see that test for how it was
 * taken). It is deterministic on purpose: fixed ids, fixed words, no clock,
 * no random — so the only thing that can change the markup is a change to
 * the renderer's no-design path.
 *
 * Uses only what main already had, so the same file can be rendered there.
 * A .ts file, not .tsx: it is a test's data, and the unused-component guard
 * counts every .tsx under components/ as something that must ship.
 */
const at = <T extends LandingSection['type']>(type: T, id: string, over: Record<string, unknown> = {}) =>
  ({ ...newSection(type), id, ...over }) as LandingSection;

export function noDesignSections(): LandingSection[] {
  return [
    at('announcement', 'g-announcement', { text: 'توصيل لكل المحافظات' }),
    at('hero', 'g-hero', { headline: 'طاقية الشعر الأصلية', subheadline: 'سطر عن المنتج', image: '/api/media/hero.jpg' }),
    at('slider', 'g-slider', { title: 'صور', images: ['/api/media/a.jpg', '/api/media/b.jpg'] }),
    at('offers', 'g-offers', { title: 'اختر العرض' }),
    at('benefits', 'g-benefits', { title: 'لماذا هذا المنتج؟', items: [{ title: 'ميزة كتبها البائع', text: 'شرحها' }, { title: 'ميزة ثانية', text: '' }] }),
    at('gallery', 'g-gallery', { title: 'معرض', images: ['/api/media/c.jpg'] }),
    at('text', 'g-text', { title: 'عن المنتج', body: 'نص كتبه البائع' }),
    at('reviews', 'g-reviews', { title: 'آراء', items: [{ ...(newSection('reviews') as { items: object[] }).items[0], name: 'سلمى', text: 'رأي نقله البائع', stars: 4 }] }),
    at('faq', 'g-faq', { title: 'أسئلة', items: [{ q: 'سؤال كتبه البائع؟', a: 'جوابه' }] }),
    at('comparison', 'g-comparison', { title: 'مقارنة', rows: [{ aspect: 'المادة', ours: 'قطن', theirs: 'صناعي' }] }),
    at('timeline', 'g-timeline', { title: 'مع الوقت', points: [{ when: 'أسبوع', what: 'فرق' }] }),
    at('quiz', 'g-quiz', { title: 'اختبار', questions: [{ ask: 'شو بدك؟', options: ['أ', 'ب'] }], result: 'نتيجة' }),
    at('objections', 'g-objections', { title: 'شكوك', items: [{ doubt: 'غالي؟', answer: 'لا' }], guarantee: 'ضمان كتبه البائع' }),
    at('mechanism', 'g-mechanism', { title: 'كيف يشتغل', steps: [{ title: 'خطوة', text: 'شرح' }], ingredients: [{ name: 'مكوّن', does: 'شغلة' }] }),
    at('urgency', 'g-urgency', { text: 'العرض لفترة', minutes: 0, showRealStock: false }),
    at('form', 'g-form'),
    at('trust', 'g-trust'),
    at('footer', 'g-footer', { text: 'جميع الحقوق محفوظة' }),
    at('sticky', 'g-sticky'),
  ];
}

export function noDesignContext(): BlockContext {
  return {
    palette: {} as BlockContext['palette'],
    productName: 'طاقية',
    price: 30,
    currency: 'USD',
    minorUnit: 2,
    stock: null,
    offers: [
      { id: 'o1', name: 'عبوتان', quantity: 2, freeQuantity: 1, price: 45, listPrice: 60, isDefault: true },
      { id: 'o2', name: 'ثلاث', quantity: 3, freeQuantity: 0, price: 60, isDefault: false },
    ],
    form: React.createElement('div', { id: 'zaki-order-form' }, 'FORM'),
    trust: trustRow(),
    whatsapp: null,
    store: { name: 'متجر', logo: null, phone: null },
    reviews: {
      items: [{ id: 'r1', rating: 5, text: 'وصلني بسرعة', firstName: 'هبة', city: 'حمص', verified: true, at: '2026-10-01' }],
      count: 1,
      average: null,
      showAverage: false,
    },
  };
}
