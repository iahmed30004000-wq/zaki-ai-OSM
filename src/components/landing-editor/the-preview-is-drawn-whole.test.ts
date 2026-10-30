import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * THE PREVIEW IS DRAWN IN FULL, AND THE WINDOW IS WHAT SCROLLS.
 *
 * «صفحة الهبوط في مشكلة ما بقدر أعمل سكرول» — and then, when offered a fix for the scroller: «بتقدر تظهرها كاملة؟
 * أفضل من السكرول». The editor's preview used to be a box as tall as the window with a scroller inside it. Measured at
 * 1900×818 the box began 233px down and ended 137px below the window, and the page inside the scroller was stretched
 * by its flex row to the scroller's own 652px and clipped there: 1088px of page, 652px shown, nothing to scroll. The
 * order form was cut off and the wheel did nothing.
 *
 * jsdom does not lay anything out, so these hold the TEXT of the rule — the failure worth catching is a well-meant edit
 * that gives the preview a height again, or an `overflow` that takes the sticky bars away from the window. The measured
 * numbers are in the pull request that made the change.
 */

const BUILDER = 'src/components/landing-editor/BlockBuilder.tsx';
const code = stripComments(repoFile(BUILDER));
const raw = repoFile(BUILDER);

const previewStart = code.indexOf('previewPaneClass(pane)');
const previewEnd = code.indexOf('<PageBlocks', previewStart);
const preview = code.slice(previewStart, previewEnd);

const layoutCss = (raw.match(/const EDITOR_LAYOUT_CSS = `([\s\S]*?)`;/) ?? [])[1] ?? '';

/*
 * The utilities that give a box a height or a clip, built from parts: Tailwind reads this file too, and a utility
 * named whole in a test is a utility shipped.
 */
const t = (...parts: string[]) => parts.join('-');
const BOXES = new RegExp(
  [
    `(^|[\\s"'\`])${t('h', 'screen')}`,
    `(^|[\\s"'\`])${t('h', '\\[')}`,
    `(^|[\\s"'\`])${t('h', 'full')}`,
    `(^|[\\s"'\`])${t('max', 'h')}-`,
    `(^|[\\s"'\`])${t('overflow', '(hidden|auto|scroll|clip)')}`,
    `(^|[\\s"'\`])${t('overflow', 'y', '(hidden|auto|scroll)')}`,
    `(^|[\\s"'\`])${t('overflow', 'x', '(hidden|auto|scroll)')}`,
  ].join('|'),
);

describe('the preview has no height of its own and no scroller', () => {
  it('found the preview pane to read', () => {
    expect(previewStart).toBeGreaterThan(0);
    expect(preview.length).toBeGreaterThan(200);
  });

  it('is not a box as tall as the screen', () => {
    expect(preview).not.toMatch(/100dvh|100vh/);
    expect(preview).not.toMatch(/\bheight:/);
    // Nor by class: the pane's own class list and the strip around the canvas.
    const classes = [...preview.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]).join(' ');
    expect(classes).not.toMatch(new RegExp([t('h', 'screen'), `${t('h', '\\[')}`, `${t('max', 'h')}-`].join('|')));
  });

  it('has no scroller inside it, and no transform that would pin the floating button to the page', () => {
    expect(preview).not.toMatch(/overflow: ?'(auto|scroll)'/);
    const classes = [...preview.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]).join(' ');
    expect(classes).not.toMatch(new RegExp(`${t('overflow', '(auto|scroll)')}|${t('overflow', '[xy]', '(auto|scroll)')}`));
    expect(preview).not.toMatch(/translateZ|transform:/);
    expect(code).not.toContain('scrollerRef');
  });

  it('rounds its corners with clip, never hidden — hidden would take the sticky bars away from the window', () => {
    // The PANE's own style (the page's canvas below it says clip too, and must not be what satisfies this), and
    // tolerant of a reformat: spacing and quotes are not the rule.
    expect(preview).toMatch(/style=\{\{\s*overflow:\s*['"]clip['"],?\s*\}\}/);
    const classes = [...preview.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]).join(' ');
    expect(classes).not.toContain(t('overflow', 'hidden'));
  });

  it('keeps a clicked block under the cursor by moving the WINDOW', () => {
    expect(code).toContain('window.scrollBy(0, moved)');
  });
});

describe('what stays in reach while the window scrolls', () => {
  it('the zoom and phone/desk bar is pinned under the system bar, at the bar’s measured height', () => {
    expect(preview).toMatch(/position: 'sticky', top: 'var\(--sys-header-h, 72px\)'/);
  });

  it('the controls are pinned on a desk and scroll inside themselves when taller than the screen', () => {
    expect(code).toContain('data-editor-controls');
    const desk = layoutCss.slice(layoutCss.indexOf('@media (min-width: 1024px)'), layoutCss.indexOf('.lp-root'));
    expect(desk).toMatch(/\[data-editor-controls\]/);
    expect(desk).toMatch(/position: sticky/);
    expect(desk).toMatch(/align-self: start/);
    expect(desk).toMatch(/max-height: calc\(100dvh - var\(--sys-header-h, 72px\)/);
    expect(desk).toMatch(/overflow-y: auto/);
  });

  it('and on a phone the controls are not pinned — the pane is simply the page', () => {
    // Everything that pins the controls sits inside the desk media query.
    const before = layoutCss.slice(0, layoutCss.indexOf('@media (min-width: 1024px)'));
    expect(before).not.toMatch(/data-editor-controls/);
    const after = layoutCss.slice(layoutCss.indexOf('.lp-root'));
    expect(after).not.toMatch(/data-editor-controls/);
  });

  it('the block bar still sticks to the bottom of the screen (nothing in between may scroll)', () => {
    const bar = repoFile('src/components/landing/blocks/PageBlocks.tsx');
    expect(bar).toMatch(/position: 'sticky', bottom: 8/);
  });
});

describe('the floating button, drawn where its block sits in the editor only', () => {
  it('is put back in the flow, and does not slide away when the form is in view', () => {
    expect(layoutCss).toMatch(/\.lp-root \.lp-sticky-bar,\s*\.lp-root \.lp-sticky-bar\[data-away\]\s*\{[^}]*position: static/);
    expect(layoutCss).toMatch(/transform: none/);
    expect(layoutCss).toMatch(/opacity: 1/);
  });

  it('NEGATIVE: the visitor’s sheet is untouched — there the bar is still fixed to the screen', () => {
    const sheet = repoFile('src/components/landing/blocks/styles.ts');
    const rule = sheet.slice(sheet.indexOf('.lp-sticky-bar {'), sheet.indexOf('.lp-sticky-bar {') + 120);
    expect(rule).toContain('position: fixed');
    expect(sheet).not.toContain('data-editor-controls');
  });
});

describe('nothing around the builder gives it a height or a clip — on either screen that mounts it', () => {
  /** Every `<div className="…">` opening from the start of the screen's last `return (` up to the builder. */
  function ancestors(file: string): string[] {
    const src = stripComments(repoFile(file));
    const at = src.indexOf('<BlockBuilder');
    expect(at, `${file}: no <BlockBuilder`).toBeGreaterThan(0);
    const from = src.lastIndexOf('return (', at);
    return [...src.slice(from, at).matchAll(/<div\s+className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
  }

  for (const file of [
    'src/components/screens/LandingPageEditorScreen.tsx',
    'src/components/screens/StoreDesignScreen.tsx',
  ]) {
    it(`${file.split('/').pop()}: no wrapper above the builder has a height, a max-height or an overflow`, () => {
      const wrappers = ancestors(file);
      expect(wrappers.length).toBeGreaterThan(0);
      for (const w of wrappers) expect(w, `${file}: «${w}»`).not.toMatch(BOXES);
    });
  }

  it('and the shop tab that holds the home panel does not clip it either', () => {
    const tab = stripComments(repoFile('src/components/store-admin/StoreAdminScreen.tsx'));
    const panel = tab.slice(tab.indexOf('{panel ? panel()') - 200, tab.indexOf('{panel ? panel()'));
    expect(panel).not.toMatch(BOXES);
  });
});

describe('the editor’s own rules for the phone and the reserved room', () => {
  it('the block bar clears the bottom navigation, by an editor-only rule', () => {
    const phone = layoutCss.slice(layoutCss.indexOf('@media (max-width: 767.98px)'));
    expect(phone).toMatch(/\[data-block-bar\]/);
    expect(phone).toMatch(/var\(--sys-mobile-nav-h, 0px\)\s*\+\s*env\(safe-area-inset-bottom\)/);
    expect(phone).toMatch(/!important/);
    // The hook is an attribute on the bar in the builder's renderer; the visitor's page never draws the bar.
    expect(repoFile('src/components/landing/blocks/PageBlocks.tsx')).toMatch(/data-block-bar\s/);
    expect(repoFile('src/components/landing/blocks/styles.ts')).not.toContain('data-block-bar');
  });

  it('the room the visitor’s page keeps for a fixed button is given back where the button is in the flow', () => {
    expect(layoutCss).toMatch(/\.lp-form-section[^{]*\{\s*padding-bottom:\s*30px/);
    expect(layoutCss).toMatch(/\.lp-footer\s*\{\s*padding-bottom:\s*28px/);
    // A custom padding look keeps its own: the override steps aside for it.
    expect(layoutCss).toContain(':where(:not([data-look-pad] *))');
    // And the visitor's sheet still reserves it.
    const sheet = repoFile('src/components/landing/blocks/styles.ts');
    expect(sheet).toContain('.lp-root:has(.lp-sticky) .lp-form-section { padding-bottom: 80px; }');
  });
});
