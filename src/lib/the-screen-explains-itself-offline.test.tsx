// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * THE GUIDE IN A WAREHOUSE WITH NO SIGNAL.
 *
 * The texts are fetched when the sheet is opened, which is a request — and
 * the people who most need to be told what the next button is are on a phone
 * in a stockroom. When the request fails the sheet must not be a blank box or
 * a spinner that never ends: it says what happened, and it still gives the
 * part that needs no request at all, because that part is read from the menu
 * the page already has — which stop this is, where the next one is, and who
 * opens the screen.
 *
 * Its own file because the texts' module is made to fail for the whole file;
 * the main test imports it for real.
 */

vi.mock('@/lib/route-guide-texts', () => {
  throw new Error('offline');
});
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/preparation' }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { ScreenGuideProvider } from '@/components/shell/ScreenGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { routeLabel } from '@/lib/route-registry';

afterEach(() => cleanup());

describe('when the texts cannot be fetched', () => {
  const open = async () => {
    render(
      <ScreenGuideProvider>
        {/* 18/11 (R3): was <ScreenTitle /> — deleted; the screen draws PageHeader with the registry name. */}
        <PageHeader title={routeLabel('/ops/preparation')} />
      </ScreenGuideProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'اشرح لي هذه الشاشة' }));
    });
    return screen.getByRole('dialog');
  };

  it('— the sheet says so, and does not wait for ever', async () => {
    const dialog = await open();
    expect(await within(dialog).findByText(/تعذّر تحميل الشرح/)).toBeTruthy();
    expect(within(dialog).queryByText('جارٍ التحميل…'), 'ما زال يحمّل').toBeNull();
    expect(within(dialog).queryByRole('listitem'), 'خطوات من العدم').toBeNull();
  });

  it('and still tells you which stop this is, where the next one is, and who opens it', async () => {
    const dialog = await open();
    await within(dialog).findByText(/تعذّر تحميل الشرح/);
    expect(dialog.textContent).toContain('الشحن · الخطوة 1 من 5');
    expect(within(dialog).getByRole('link', { name: /التالي: إنشاء شحنة/ }).getAttribute('href')).toBe('/ops/shipments/new');
    expect(dialog.textContent).toContain('تفتحها صلاحية:');
  });
});
