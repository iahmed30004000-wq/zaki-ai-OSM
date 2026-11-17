// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «القيم المطلوبة» — the card (the media buyer's doors, PR-C): a saved value is never drawn back, only «محفوظ ✓ · آخر 4»; the box starts empty and is a password box;
 * «مسح» asks twice; «جرّب» says a verdict. The server (not this card) decides who may — here only what comes back is drawn.
 */

const h = vi.hoisted(() => ({ apiJson: vi.fn(), done: vi.fn(), failed: vi.fn(), confirm: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => h.apiJson(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: h.done, failed: h.failed, warn: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => h.confirm }));

import { IntegrationFieldsCard } from './IntegrationFieldsCard';

const item = (over: Record<string, unknown>) => ({
  key: 'K', group: 'whatsapp', label: 'اسم', help: 'مساعدة', source: 'none', hint: null, envSet: false, unreadable: false, ...over,
});

const ITEMS = [
  item({ key: 'WHATSAPP_ACCESS_TOKEN', label: 'رمز الوصول (واتساب)', source: 'site', hint: '1234' }),
  item({ key: 'WHATSAPP_PHONE_NUMBER_ID', label: 'معرّف رقم الهاتف', source: 'env', envSet: true }),
  item({ key: 'WHATSAPP_APP_SECRET', label: 'App Secret من Meta' }),
  item({ key: 'TELEGRAM_BOT_TOKEN', group: 'telegram', label: 'رمز البوت', source: 'site', hint: 'abcd' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  h.confirm.mockResolvedValue(true);
  h.apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/settings/integrations' && !init?.method) return { items: ITEMS };
    if (url === '/api/settings/integrations/test') return { ok: true, message: 'يشتغل · @zaki_bot' };
    return { ok: true };
  });
});
afterEach(cleanup);

describe('the card', () => {
  it('draws where each setting comes from: saved here with its last four, from the environment, or missing — and only its own group', async () => {
    render(<IntegrationFieldsCard group="whatsapp" />);
    await screen.findByText('رمز الوصول (واتساب)');
    expect(screen.getByText(/محفوظ · آخر 4:/)).toBeTruthy();
    expect(screen.getByText('1234')).toBeTruthy();
    expect(screen.getByText('من البيئة')).toBeTruthy();
    expect(screen.getByText('ناقص')).toBeTruthy();
    expect(screen.queryByText('رمز البوت')).toBeNull();
  });

  it('a saved value is never drawn back: every box is empty and a password box', async () => {
    render(<IntegrationFieldsCard group="whatsapp" />);
    await screen.findByText('رمز الوصول (واتساب)');
    const boxes = screen.getAllByPlaceholderText('قيمة جديدة') as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      expect(b.value).toBe('');
      expect(b.type).toBe('password');
      expect(b.getAttribute('autocomplete')).toBe('off');
    }
  });

  it('draws nothing at all when the server lists nothing for the group (a person without that card’s key), or when it cannot be read', async () => {
    render(<IntegrationFieldsCard group="telegram" />);
    await screen.findByText('رمز البوت');
    cleanup();
    h.apiJson.mockResolvedValue({ items: [] });
    const empty = render(<IntegrationFieldsCard group="whatsapp" />);
    await waitFor(() => expect(h.apiJson).toHaveBeenCalled());
    expect(empty.container.textContent).toBe('');
    cleanup();
    h.apiJson.mockRejectedValue(new Error('down'));
    const down = render(<IntegrationFieldsCard group="whatsapp" />);
    await waitFor(() => expect(h.apiJson).toHaveBeenCalled());
    expect(down.container.textContent).toBe('');
  });

  it('«حفظ» is off until there is a value; saving sends the name and the value to the door, empties the box and says it was saved', async () => {
    render(<IntegrationFieldsCard group="whatsapp" />);
    await screen.findByText('App Secret من Meta');
    const secretBox = screen.getByLabelText('App Secret من Meta') as HTMLInputElement;
    const saveButtons = screen.getAllByRole('button', { name: 'حفظ' }) as HTMLButtonElement[];
    expect(saveButtons.every((b) => b.disabled)).toBe(true);
    fireEvent.change(secretBox, { target: { value: 'my-new-app-secret' } });
    const enabled = (screen.getAllByRole('button', { name: 'حفظ' }) as HTMLButtonElement[]).filter((b) => !b.disabled);
    expect(enabled).toHaveLength(1);
    fireEvent.click(enabled[0]);
    await waitFor(() => expect(h.done).toHaveBeenCalledWith('انحفظ'));
    const put = h.apiJson.mock.calls.find(([u, i]) => u === '/api/settings/integrations' && i?.method === 'PUT')!;
    expect(JSON.parse(put[1].body)).toEqual({ key: 'WHATSAPP_APP_SECRET', value: 'my-new-app-secret' });
    await waitFor(() => expect((screen.getByLabelText('App Secret من Meta') as HTMLInputElement).value).toBe(''));
  });

  it('a refusal by the server is shown as it came, and nothing is claimed as saved', async () => {
    render(<IntegrationFieldsCard group="whatsapp" />);
    await screen.findByText('App Secret من Meta');
    h.apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') throw new Error('القيمة مش بالشكل المطلوب: أرقام بس');
      return { items: ITEMS };
    });
    fireEvent.change(screen.getByLabelText('معرّف رقم الهاتف'), { target: { value: 'abc' } });
    fireEvent.click((screen.getAllByRole('button', { name: 'حفظ' }) as HTMLButtonElement[]).find((b) => !b.disabled)!);
    await waitFor(() => expect(h.failed).toHaveBeenCalledWith('القيمة مش بالشكل المطلوب: أرقام بس'));
    expect(h.done).not.toHaveBeenCalled();
  });

  it('«مسح» exists only for what is saved here, and asks in the app’s own dialog first: declined, nothing is sent', async () => {
    render(<IntegrationFieldsCard group="whatsapp" />);
    await screen.findByText('رمز الوصول (واتساب)');
    const clear = screen.getAllByRole('button', { name: 'مسح' });
    expect(clear).toHaveLength(1);
    h.confirm.mockResolvedValueOnce(false);
    fireEvent.click(clear[0]);
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ tone: 'danger', confirmLabel: 'مسح' });
    expect(h.apiJson.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'مسح' })[0]);
    await waitFor(() => expect(h.done).toHaveBeenCalledWith('انمسح'));
    const del = h.apiJson.mock.calls.find(([, i]) => i?.method === 'DELETE')!;
    expect(JSON.parse(del[1].body)).toEqual({ key: 'WHATSAPP_ACCESS_TOKEN' });
  });

  it('«جرّب» asks for the group and shows the verdict', async () => {
    render(<IntegrationFieldsCard group="telegram" />);
    await screen.findByText('رمز البوت');
    fireEvent.click(screen.getByRole('button', { name: 'جرّب' }));
    await screen.findByText('يشتغل · @zaki_bot');
    const call = h.apiJson.mock.calls.find(([u]) => u === '/api/settings/integrations/test')!;
    expect(JSON.parse(call[1].body)).toEqual({ group: 'telegram' });
  });
});
