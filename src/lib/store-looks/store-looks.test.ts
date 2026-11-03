import { describe, expect, it } from 'vitest';
import {
  HOME_DESIGNS, HOME_DESIGN_IDS, LOOK_IDS, RADIUS_SCALE, STORE_LOOKS, applyLook, designSections, homeDesign,
  lookTokens, lookVars,
} from './index';
import { DESIGN_NAMES, LOOK_NAMES } from './names.generated';
import { landingSectionSchema } from '../landing-sections';
import { CONTRAST_PAIRS } from '../store-skin';
import { DEFAULT_STORE_THEME, parseStoreTheme, storeThemeSchema, storeThemeVars, themeRoleColors } from '../store-theme';
import { contrastRatio } from '../landing-theme';
import { STORE_TEMPLATES } from '../store-templates';
import { PAGE_TEMPLATES } from '../page-templates';

/**
 * THE THIRTEEN LOOKS AND THE EIGHTEEN DESIGNS, ALL OF THEM, BESIDE OURS.
 */
describe('the catalogue is whole', () => {
  it('carries their thirteen themes, each with its tokens and its name', () => {
    expect(LOOK_IDS).toHaveLength(13);
    expect(STORE_LOOKS.map((l) => l.id)).toEqual([...LOOK_IDS]);
    for (const id of LOOK_IDS) {
      const look = lookTokens(id)!;
      expect(look, id).not.toBeNull();
      expect(LOOK_NAMES[id]?.label, id).toBeTruthy();
      for (const [role, hex] of Object.entries(look.colors)) expect(hex, `${id}.${role}`).toMatch(/^#[0-9a-f]{6}$/);
      for (const r of Object.values(look.radius)) expect(r, id).toMatch(/^\d{1,3}px$/);
    }
  });

  it('carries their eighteen home designs, each wearing one of the thirteen and opening on a slider', () => {
    expect(HOME_DESIGN_IDS).toHaveLength(18);
    expect(HOME_DESIGNS.map((d) => d.id)).toEqual([...HOME_DESIGN_IDS]);
    for (const d of HOME_DESIGNS) {
      expect(lookTokens(d.look), d.id).not.toBeNull();
      expect(DESIGN_NAMES[d.id], d.id).toBeTruthy();
      expect(d.blocks[0].type, d.id).toBe('slider');
    }
  });

  it('and none of ours is gone: eleven skins and fifteen home templates', () => {
    expect(STORE_TEMPLATES).toHaveLength(11);
    expect(PAGE_TEMPLATES).toHaveLength(15);
  });

  it('every design becomes blocks our library accepts, with no title of theirs and no typed review', () => {
    for (const d of HOME_DESIGNS) {
      const sections = designSections(d);
      expect(sections.length, d.id).toBe(d.blocks.length);
      for (const s of sections) {
        expect(landingSectionSchema.safeParse(s).success, `${d.id}:${s.type}`).toBe(true);
        if (s.type === 'catalog' || s.type === 'slider' || s.type === 'gallery') expect(s.title, d.id).toBe('');
      }
      expect(sections.some((s) => s.type === 'reviews'), d.id).toBe(false);
      // A singleton appears once.
      expect(sections.filter((s) => s.type === 'trust').length, d.id).toBeLessThanOrEqual(1);
    }
  });

  it('reads nothing for an id it does not carry', () => {
    for (const bad of [undefined, null, '', 'no-such', '__proto__', 7, '<script>']) {
      expect(lookTokens(bad)).toBeNull();
      expect(homeDesign(bad)).toBeNull();
    }
  });
});

describe('a look is readable — every text pair our skins are held to', () => {
  it.each([...LOOK_IDS])('«%s» passes the contrast floor once tried on', (id) => {
    const theme = applyLook(DEFAULT_STORE_THEME, lookTokens(id)!);
    const roles = themeRoleColors(theme);
    const failing = CONTRAST_PAIRS.filter((p) => contrastRatio(roles[p.fg], roles[p.bg]) < p.min).map(
      (p) => `${p.what} ${contrastRatio(roles[p.fg], roles[p.bg]).toFixed(2)}`
    );
    expect(failing).toEqual([]);
  });
});

describe('the customizer’s new keys, stored and read back', () => {
  const full = {
    ...DEFAULT_STORE_THEME,
    look: 'nova',
    radius: 'round',
    motion: 'full',
    highlight: '#e0533d',
    header: { height: 72, sticky: true, onFrontPage: true, logoHeight: 56 },
    ticker: { enabled: true, mode: 'static', phone: true, items: ['جملة البائع'] },
  };

  it('round-trips through the schema and the parser unchanged', () => {
    expect(storeThemeSchema.safeParse(full).success).toBe(true);
    const back = parseStoreTheme(JSON.stringify(full));
    expect(back.look).toBe('nova');
    expect(back.radius).toBe('round');
    expect(back.motion).toBe('full');
    expect(back.highlight).toBe('#e0533d');
    expect(back.header?.logoHeight).toBe(56);
    expect(back.ticker).toEqual(full.ticker);
  });

  it('refuses what is out of their range', () => {
    for (const bad of [
      { header: { ...full.header, logoHeight: 120 } },
      { motion: 'bold' },
      { radius: 'pill' },
      { look: 'no-such' },
      { ticker: { ...full.ticker, items: Array(7).fill('x') } },
    ]) {
      expect(storeThemeSchema.safeParse({ ...full, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a stale look id loses the id, not the shop’s ticker and motion with it', () => {
    const back = parseStoreTheme(JSON.stringify({ ...full, look: 'gone-look' }));
    expect(back.look).toBeUndefined();
    expect(back.motion).toBe('full');
    expect(back.ticker?.enabled).toBe(true);
    expect(back.accent).toBe(DEFAULT_STORE_THEME.accent);
  });

  it('a theme that never set them gains no key and no variable', () => {
    const plain = parseStoreTheme(JSON.stringify({ accent: '#0d6ba8', mood: 'clean', font: 'ibm', corners: 'soft' }));
    for (const k of ['look', 'radius', 'motion', 'ticker', 'highlight'] as const) expect(plain[k], k).toBeUndefined();
    expect(plain.header?.logoHeight).toBeUndefined();
    expect(lookVars(plain)).toEqual({});
    const vars = storeThemeVars(plain);
    for (const v of ['--look-btn-r', '--look-shadow', '--store-highlight', '--store-highlight-ink', '--store-logo-h']) {
      expect(vars[v], v).toBeUndefined();
    }
  });
});

describe('what a look and a corner level paint', () => {
  it('a look writes its own card, button and field radius and its shadows', () => {
    const nova = lookTokens('nova')!;
    const v = lookVars({ look: 'nova' });
    expect(v['--store-radius']).toBe(nova.radius.card);
    expect(v['--look-btn-r']).toBe('999px');
    // `none` cannot sit in a list of shadows; it is written as a shadow that draws nothing.
    expect(v['--look-shadow']).toBe('0 0 0 0 transparent');
  });

  it('a level the seller picked beats the look', () => {
    expect(lookVars({ look: 'nova', radius: 'sharp' })['--look-btn-r']).toBe(RADIUS_SCALE.sharp.button);
  });

  it('sharp and soft are the card radius a landing theme always drew for its two corners', () => {
    const sharp = storeThemeVars({ ...DEFAULT_STORE_THEME, corners: 'sharp' })['--store-radius'];
    const soft = storeThemeVars({ ...DEFAULT_STORE_THEME, corners: 'soft' })['--store-radius'];
    expect(RADIUS_SCALE.sharp.card).toBe(sharp);
    expect(RADIUS_SCALE.soft.card).toBe(soft);
  });

  it('the highlight colours the badge unless the shop named the badge itself', () => {
    expect(storeThemeVars({ ...DEFAULT_STORE_THEME, highlight: '#ffb020' })['--store-offer-badge']).toBe('#ffb020');
    expect(
      storeThemeVars({ ...DEFAULT_STORE_THEME, highlight: '#ffb020', colors: { offerBadge: '#111111' } })['--store-offer-badge']
    ).toBe('#111111');
  });

  it('trying a look copies its colours and keeps the shop’s fonts, checkout and words', () => {
    const before = parseStoreTheme(
      JSON.stringify({ ...DEFAULT_STORE_THEME, font: 'cairo', checkout: { submitText: 'اطلب', fieldOrder: [], required: [], hidden: [], afterOrderMessage: '' }, footer: { copyright: 'حقوقي' } })
    );
    const after = applyLook(before, lookTokens('souq')!);
    expect(after.accent).toBe('#071b33');
    expect(after.highlight).toBe('#ffb020');
    expect(after.look).toBe('souq');
    expect(after.font).toBe('cairo');
    expect(after.checkout).toEqual(before.checkout);
    expect(after.footer).toEqual(before.footer);
    expect(storeThemeSchema.safeParse(after).success).toBe(true);
  });
});
