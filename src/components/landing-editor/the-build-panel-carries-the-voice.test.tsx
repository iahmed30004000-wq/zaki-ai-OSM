// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE PANEL SENDS THE WIZARD'S «الأسلوب» WITH THE BUILD — and nothing in
 * its place when none was chosen, so the brief is the one it always was.
 */

const { screenApi } = vi.hoisted(() => ({ screenApi: vi.fn() }));
vi.mock('@/lib/screen-api', () => ({ screenApi: (...a: unknown[]) => screenApi(...a) }));

import { BuildMyLandingPage } from './BuildMyLandingPage';

const buildBody = () => {
  const call = screenApi.mock.calls.find((c) => c[0] === '/api/ai/landing-build');
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  screenApi.mockImplementation(async (path: string) => {
    if (path === '/api/ai/landing-match') return { picks: [] };
    if (path === '/api/ai/landing-build') return { fields: [], promises: [] };
    return {};
  });
});
afterEach(cleanup);

describe('«ابنيلي صفحة الهبوط» and the voice', () => {
  it('sends the tone it was given', async () => {
    const user = userEvent.setup();
    render(<BuildMyLandingPage productId="p1" onApply={vi.fn()} tone="premium" />);
    await user.click(screen.getByRole('button', { name: /ابنيلي صفحة الهبوط/ }));
    await vi.waitFor(() => expect(buildBody()).not.toBeNull());
    expect(buildBody().tone).toBe('premium');
    expect(buildBody().productId).toBe('p1');
  });

  it('sends no tone key when none was chosen', async () => {
    const user = userEvent.setup();
    render(<BuildMyLandingPage productId="p1" onApply={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /ابنيلي صفحة الهبوط/ }));
    await vi.waitFor(() => expect(buildBody()).not.toBeNull());
    expect('tone' in buildBody()).toBe(false);
  });
});
