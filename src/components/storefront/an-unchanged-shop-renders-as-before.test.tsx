// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';

// Unmount what each test drew: a tree left mounted when the file ends is
// still scheduled work, and it runs after the DOM is gone («window is not defined»).
afterEach(cleanup);
import { StorefrontShell } from './StorefrontShell';
import { PageBlocks } from '@/components/landing/blocks/PageBlocks';
import { unchangedContext, unchangedHome, unchangedShops } from './unchanged-shop.fixture';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => '/s/golden-shop' }));

/**
 * A SHOP THAT CHANGES NOTHING IS DRAWN EXACTLY AS IT WAS.
 *
 * The store looks, the home designs, the customizer's new controls and the
 * slider's per-slide fields are all ADDITIONS: a key a shop has never saved
 * must draw nothing new — no attribute, no variable, no stylesheet, no bar.
 *
 * `__golden__/unchanged-shop.html` was rendered on `osm/main` (5e37c1ac) by
 * this same call, from a worktree with none of that code in it
 * (a one-off write of `draw()` on that commit; it is never re-taken from
 * this branch's own output). Comparing a shop
 * with the new keys absent against itself would prove nothing; comparing it
 * with what main drew does: one attribute added to an untouched shop fails
 * it.
 */
const GOLDEN_FILE = join(__dirname, '__golden__', 'unchanged-shop.html');

function draw(): string {
  return unchangedShops()
    .map((shop) =>
      render(
        <StorefrontShell store={shop}>
          <PageBlocks sections={unchangedHome()} ctx={unchangedContext(shop)} />
        </StorefrontShell>
      ).container.innerHTML
    )
    .join('\n<!-- next shop -->\n');
}

describe('a shop that changed nothing', () => {
  it('is drawn byte for byte as main drew it', () => {
    const html = draw();
    expect(existsSync(GOLDEN_FILE), 'النسخة الذهبية غائبة').toBe(true);
    expect(html).toBe(readFileSync(GOLDEN_FILE, 'utf8').replace(/\r\n/g, '\n'));
  });

  it('and the golden copy is a real shop — the header, the blocks and the footer all drew', () => {
    const golden = readFileSync(GOLDEN_FILE, 'utf8');
    for (const must of ['sf-header', 'sf-search', 'lp-catalog', 'lp-slider', 'lp-footer', 'متجر التجربة', 'كل الحقوق لمتجر التجربة']) {
      expect(golden, must).toContain(must);
    }
  });
});
