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

describe('the preview has no height of its own and no scroller', () => {
  it('found the preview pane to read', () => {
    expect(previewStart).toBeGreaterThan(0);
    expect(preview.length).toBeGreaterThan(200);
  });

  it('is not a box as tall as the screen', () => {
    expect(preview).not.toMatch(/100dvh|100vh/);
    expect(preview).not.toMatch(/\bheight:/);
  });

  it('has no scroller inside it, and no transform that would pin the floating button to the page', () => {
    expect(preview).not.toMatch(/overflow-auto|overflow-y-auto|overflow: ?'auto'|overflow: ?'scroll'/);
    expect(preview).not.toMatch(/translateZ|transform:/);
    expect(code).not.toContain('scrollerRef');
  });

  it('rounds its corners with clip, never hidden — hidden would take the sticky bars away from the window', () => {
    // The PANE's own style (the page's canvas below it says clip too, and must not be what satisfies this).
    expect(preview).toContain("style={{ overflow: 'clip' }}");
    expect(preview).not.toMatch(/overflow-hidden/);
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
