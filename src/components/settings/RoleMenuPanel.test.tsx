// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «قائمة كل دور» (18/11, R7) — the panel on the roles screen that took the role's three decisions off everybody's
 * «ترتيب القائمة» card. Held here: it is drawn only for the door's `maySetRoleBase`, it survives a door that answers
 * nothing (the roles screen's other tests fake the network loosely), and a new role is a new card, read from the start.
 * The rest — the four, the look, the save to the role — is held in `the-menu-groups-and-the-phones-four-can-be-arranged`.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { RoleMenuPanel } from './RoleMenuPanel';
import { EMPTY_LAYOUT } from '@/lib/nav-arrangement';

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function serve(may: unknown, roles: { id: string; name: string }[] = [{ id: 'a', name: 'مشرف' }, { id: 'b', name: 'موظفة' }]) {
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/nav/arrangement' && !init?.method) return may === undefined ? undefined : { resolved: EMPTY_LAYOUT, own: null, paths: ['/orders', '/customers'], maySetRoleBase: may };
    if (url === '/api/roles') return { roles };
    if (url.startsWith('/api/nav/arrangement?roleId=')) return { layout: EMPTY_LAYOUT };
    return {};
  });
}
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

describe('the role panel', () => {
  it('is drawn for the holder of the door’s flag', async () => {
    serve(true);
    render(<RoleMenuPanel />);
    expect(await screen.findByText('قائمة كل دور')).toBeTruthy();
  });

  it.each([
    ['the flag is false', false],
    ['the door answered nothing', undefined],
    ['the flag is not a yes', 'yes-ish'],
  ])('NEGATIVE: draws nothing when %s', async (_n, may) => {
    serve(may === 'yes-ish' ? 0 : may);
    const { container } = render(<RoleMenuPanel />);
    await settle();
    expect(container.innerHTML).toBe('');
    expect(apiJson.mock.calls.some((c) => c[0] === '/api/roles')).toBe(false);
  });

  it('NEGATIVE: draws nothing when the door refuses', async () => {
    apiJson.mockRejectedValue(new Error('x'));
    const { container } = render(<RoleMenuPanel />);
    await settle();
    expect(container.innerHTML).toBe('');
  });

  it('and switching roles reads the NEW role’s base — the card is a new one, never the last role’s rows', async () => {
    serve(true);
    render(<RoleMenuPanel />);
    const picker = (await screen.findByLabelText('الدور')) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'a' } });
    });
    await screen.findAllByRole('listitem');
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'b' } });
    });
    await screen.findAllByRole('listitem');
    const reads = apiJson.mock.calls.filter((c) => String(c[0]).startsWith('/api/nav/arrangement?roleId=')).map((c) => c[0]);
    expect(reads).toEqual(['/api/nav/arrangement?roleId=a', '/api/nav/arrangement?roleId=b']);
  });

  it('and after switching roles there is exactly ONE card and ONE «احفظ» — and it saves to the role the picker names', async () => {
    serve(true);
    render(<RoleMenuPanel />);
    const picker = (await screen.findByLabelText('الدور')) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'a' } });
    });
    await screen.findAllByRole('listitem');
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'b' } });
    });
    await waitFor(() => expect(apiJson.mock.calls.some((c) => c[0] === '/api/nav/arrangement?roleId=b')).toBe(true));
    await screen.findAllByRole('listitem');
    await settle();
    expect(screen.getAllByText('احفظ')).toHaveLength(1);
    expect(document.querySelectorAll('#menu-order')).toHaveLength(1);
    expect(screen.getAllByLabelText('المظهر الذي يفتح عليه هذا الدور')).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByText('احفظ'));
    });
    const put = apiJson.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(put.map((c) => c[0])).toEqual(['/api/nav/arrangement?roleId=b']);
  });

  it('and the look chosen for one role is not shown against the next role’s name', async () => {
    serve(true);
    render(<RoleMenuPanel />);
    const picker = (await screen.findByLabelText('الدور')) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'a' } });
    });
    const look = () => screen.getByLabelText('المظهر الذي يفتح عليه هذا الدور') as HTMLSelectElement;
    const choice = (within(look()).getAllByRole('option')[1] as HTMLOptionElement).value;
    await act(async () => {
      fireEvent.change(look(), { target: { value: choice } });
    });
    await screen.findByText('انحفظ.');
    expect(look().value).toBe(choice);
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'b' } });
    });
    expect(look().value).toBe('');
    expect(screen.queryByText('انحفظ.')).toBeNull();
  });

  it('and going back to «اختر دور» takes the role’s card away', async () => {
    serve(true);
    render(<RoleMenuPanel />);
    const picker = (await screen.findByLabelText('الدور')) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'a' } });
    });
    await screen.findAllByRole('listitem');
    await act(async () => {
      fireEvent.change(picker, { target: { value: '' } });
    });
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByText('احفظ')).toBeNull();
  });
});
