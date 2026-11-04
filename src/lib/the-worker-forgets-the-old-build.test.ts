import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SERVICE WORKER, RUN — ONE BUILD'S FILES, AND A PAGE THAT GIVES UP.
 *
 * `public/sw.js` is executed here against a fake `self`, `caches` and
 * `fetch`, so what is checked is what it DOES, not what it says:
 *
 *   - the framework's files of a new build empty the old build's cache
 *     (one cache name per build, from `?dpl=`), and a 404 empties nothing;
 *   - a page the server does not answer in time becomes the offline page;
 *   - a write and an API read are still never touched (the file's rule).
 * ═══════════════════════════════════════════════════════════════════════
 */

const ORIGIN = 'https://oms.test';

type Listener = (event: Record<string, unknown>) => void;

function boot() {
  const listeners = new Map<string, Listener>();
  const store = new Map<string, Map<string, Response>>();
  const fetchMock = vi.fn<(req: Request, init?: RequestInit) => Promise<Response>>();

  const cacheOf = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      put: async (req: Request | string, res: Response) => void m.set(typeof req === 'string' ? new URL(req, ORIGIN).href : req.url, res),
      match: async (req: Request | string) => m.get(typeof req === 'string' ? new URL(req, ORIGIN).href : req.url)?.clone(),
      addAll: async (urls: string[]) => urls.forEach((u) => m.set(new URL(u, ORIGIN).href, new Response(`cached ${u}`))),
    };
  };
  const caches = {
    open: async (name: string) => cacheOf(name),
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    match: async (req: Request, opts?: { cacheName?: string }) => {
      const names = opts?.cacheName ? [opts.cacheName] : [...store.keys()];
      for (const n of names) {
        const hit = store.get(n)?.get(req.url);
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };

  vm.runInNewContext(readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8'), {
    self,
    caches,
    fetch: fetchMock,
    URL,
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
    console,
    addEventListener: self.addEventListener,
  });

  /** Dispatch a fetch; resolves to what the worker answered, or `undefined` when it let the browser have it. */
  const dispatch = async (url: string, init: RequestInit & { mode?: RequestMode } = {}) => {
    const request = new Request(new URL(url, ORIGIN), { method: init.method ?? 'GET' });
    // `mode: 'navigate'` cannot be set on a constructed Request; the worker only reads the property.
    const req = init.mode ? Object.defineProperty(request, 'mode', { value: init.mode }) : request;
    let answered: Promise<Response> | undefined;
    listeners.get('fetch')!({ request: req, respondWith: (p: Promise<Response>) => (answered = Promise.resolve(p)) });
    return answered;
  };

  const install = async () => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get('install')!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };

  return { dispatch, install, store, fetchMock };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('one build’s files on the phone, the one it is running', () => {
  it('files of build A go into A’s own cache', async () => {
    const w = boot();
    w.fetchMock.mockResolvedValue(new Response('a', { status: 200 }));
    const res = await w.dispatch('/_next/static/chunks/a.js?dpl=A');
    expect(await res!.text()).toBe('a');
    await vi.waitFor(() => expect(w.store.get('static-A')?.size).toBe(1));
  });

  it('the first file of build B empties A’s cache, and the shell cache is left alone', async () => {
    const w = boot();
    await w.install();
    const shell = [...w.store.keys()].find((k) => k.startsWith('shell-'))!;
    expect(shell).toBeTruthy();

    w.fetchMock.mockImplementation(async () => new Response('x', { status: 200 }));
    await w.dispatch('/_next/static/chunks/a.js?dpl=A');
    await vi.waitFor(() => expect(w.store.has('static-A')).toBe(true));

    await w.dispatch('/_next/static/chunks/b.js?dpl=B');
    await vi.waitFor(() => expect(w.store.has('static-B')).toBe(true));
    expect(w.store.has('static-A'), 'the old build’s files outlived the deploy').toBe(false);
    expect(w.store.has(shell)).toBe(true);
  });

  it('a second file of the same build is served from its cache without the network', async () => {
    const w = boot();
    w.fetchMock.mockImplementation(async () => new Response('a', { status: 200 }));
    await w.dispatch('/_next/static/chunks/a.js?dpl=A');
    await vi.waitFor(() => expect(w.store.get('static-A')?.size).toBe(1));
    w.fetchMock.mockClear();
    const again = await w.dispatch('/_next/static/chunks/a.js?dpl=A');
    expect(await again!.text()).toBe('a');
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it('an old tab’s 404 for a file the new build dropped empties nothing', async () => {
    const w = boot();
    w.fetchMock.mockImplementationOnce(async () => new Response('b', { status: 200 }));
    await w.dispatch('/_next/static/chunks/b.js?dpl=B');
    await vi.waitFor(() => expect(w.store.has('static-B')).toBe(true));

    w.fetchMock.mockImplementationOnce(async () => new Response('gone', { status: 404 }));
    const res = await w.dispatch('/_next/static/chunks/old.js?dpl=A');
    expect(res!.status).toBe(404);
    await new Promise((r) => setTimeout(r, 10));
    expect(w.store.has('static-B')).toBe(true);
    expect(w.store.has('static-A')).toBe(false);
  });
});

describe('a page the server does not answer', () => {
  it('becomes the offline page after the time limit, instead of a white screen for minutes', async () => {
    vi.useFakeTimers();
    const w = boot();
    await w.install();
    w.fetchMock.mockImplementation(
      (_req, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const answered = w.dispatch('/orders', { mode: 'navigate' });
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await (await answered)!;
    expect(await res.text()).toBe('cached /offline.html');
  });

  it('and a page that answers in time is the page', async () => {
    const w = boot();
    w.fetchMock.mockResolvedValue(new Response('<html>orders</html>', { status: 200 }));
    const res = await w.dispatch('/orders', { mode: 'navigate' });
    expect(await res!.text()).toBe('<html>orders</html>');
  });
});

describe('the rule at the top of the file still holds', () => {
  it('a write is never intercepted', async () => {
    const w = boot();
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(await w.dispatch('/_next/static/chunks/a.js?dpl=A', { method }), method).toBeUndefined();
    }
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it('nor an API read', async () => {
    const w = boot();
    expect(await w.dispatch('/api/orders')).toBeUndefined();
    expect(await w.dispatch('/api/orders', { mode: 'navigate' })).toBeUndefined();
    expect(w.fetchMock).not.toHaveBeenCalled();
  });
});

describe('the offline page tells a dead server from a dead line', () => {
  const html = () => readFileSync(join(process.cwd(), 'public', 'offline.html'), 'utf8');
  it('says the server is not answering when the browser is online, and tries again by itself', () => {
    const src = html();
    expect(src).toContain('if (navigator.onLine)');
    expect(src).toContain('الخادم لا يردّ الآن');
    expect(src).toMatch(/setTimeout\(\(\) => location\.reload\(\), \d+\)/);
  });
});
