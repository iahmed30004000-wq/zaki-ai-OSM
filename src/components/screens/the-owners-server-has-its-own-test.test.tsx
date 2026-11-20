// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * «اختبار خادمك» on the AI screen (20/11, A1): under «عنوان الخادم», it asks
 * the test door for the SAVED server ({ target: 'LOCAL' } and nothing else),
 * repeats the server's own answer, and is locked while the box holds an
 * address that was not saved yet.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: async () => ({}) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/ai',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    currentUser: { id: 'u1', role: 'SUPER_ADMIN', status: 'ACTIVE', permissions: ['settings.view', 'settings.manage'] },
    t: {},
    locale: 'ar',
  }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));

import { AiSettingsScreen } from './AiSettingsScreen';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Confirm';

const PROVIDERS = [
  { id: 'LOCAL', label: 'نموذج على خادمك', defaultModel: 'l1', models: ['l1'], keyHelp: 'غالباً بلا مفتاح', needsEndpoint: true, keyOptional: true },
];
const SETTINGS = { provider: 'LOCAL', model: 'l1', prompt: '', prompts: {}, hasKey: false, assistants: {} };
let saved: string | null = 'http://localhost:11434';
let localAnswer: unknown = { ok: true, provider: 'LOCAL', host: 'localhost', model: 'l1', reply: 'OK' };

const res = (ok: boolean, body: unknown) => ({ ok, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  saved = 'http://localhost:11434';
  localAnswer = { ok: true, provider: 'LOCAL', host: 'localhost', model: 'l1', reply: 'OK' };
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/settings/ai' && !init?.method) {
      return res(true, {
        settings: SETTINGS, usage: null, providers: PROVIDERS, jobs: [], routes: {},
        defaultRoute: { provider: 'LOCAL', model: 'l1', keyFrom: 'none', baseUrl: saved },
      });
    }
    if (url === '/api/settings/ai/system') {
      return res(true, {
        system: {
          provider: 'LOCAL', model: 'l1', providerKeys: {}, localBaseUrl: saved,
          compat: { baseUrl: null, host: null, model: null }, savedAt: null, savedBy: null, encryptionAvailable: true,
        },
        providers: PROVIDERS,
      });
    }
    if (url === '/api/settings/ai/test') {
      return init?.body ? res(true, localAnswer) : res(true, { ok: true, provider: 'LOCAL', model: 'l1', reply: 'عام' });
    }
    return res(true, {});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = async () => {
  const out = render(
    <ToastProvider>
      <ConfirmProvider>
        <AiSettingsScreen />
      </ConfirmProvider>
    </ToastProvider>
  );
  await screen.findByText('اختبار خادمك');
  return out;
};
const button = () => screen.getByRole('button', { name: /اختبار خادمك/ }) as HTMLButtonElement;
const localPosts = () =>
  fetchMock.mock.calls.filter(([u, init]) => u === '/api/settings/ai/test' && (init as { body?: string } | undefined)?.body);

describe('«اختبار خادمك»', () => {
  it('asks for the saved server with { target: LOCAL } and nothing else, and repeats its answer', async () => {
    await draw();
    expect(button().getAttribute('type')).toBe('button');
    fireEvent.click(button());
    await screen.findByText('خادمك ردّ (l1): «OK»');
    expect(localPosts()).toHaveLength(1);
    expect(JSON.parse((localPosts()[0][1] as { body: string }).body)).toEqual({ target: 'LOCAL' });
  });

  it('a refusal is the server’s own Arabic sentence', async () => {
    localAnswer = { ok: false, code: 'NOT_OPENAI', error: 'الخادم ما بيحكي بنفس اللغة — ردّ بشي مش على شكل OpenAI.' };
    await draw();
    fireEvent.click(button());
    await screen.findByText(/الخادم ما بيحكي بنفس اللغة/);
  });

  it('NEGATIVE: locked while the box holds an address that was not saved', async () => {
    const { container } = await draw();
    fireEvent.change(container.querySelector('#ai-local-url') as HTMLInputElement, { target: { value: 'http://localhost:9999' } });
    expect(button().disabled).toBe(true);
    expect(screen.getByText('احفظ العنوان أولاً، بعدين جرّبه.')).not.toBeNull();
    fireEvent.click(button());
    expect(localPosts()).toHaveLength(0);
  });

  it('NEGATIVE: locked when no address is saved at all', async () => {
    saved = null;
    await draw();
    expect(button().disabled).toBe(true);
  });

  it('the general «اختبار الاتصال» still asks the default route with no body', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /اختبار الاتصال/ }));
    await screen.findByText(/ردّ: «عام»/);
    expect(localPosts()).toHaveLength(0);
  });
});
