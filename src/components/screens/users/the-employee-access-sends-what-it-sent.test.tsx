// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE EMPLOYEE'S COUNTRIES, STORES AND PHONE SEND, BYTE FOR BYTE, WHAT THEY SENT (R16c, 18/11)
 *
 * The country and store boxes on the employee's page moved onto the kit's `Checkbox` (an id carrying the person, the
 * country or the store). What a person may enter is a door too, so the copy as it stood on main
 * (`UserAccessSections.as-on-main.test.tsx`) and the live file are driven through the same presses and must send the
 * same requests: the same URL, method and body string. And with the edit key absent, both draw the boxes locked and no
 * save — the census of buttons, boxes and fields must match at the moment of the last press.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  countries: [] as Array<{ id: string; name: string; stores: Array<{ id: string; name: string }> }>,
  access: { countryIds: [] as string[], storeIds: [] as string[] },
  loadFails: false,
  write: { status: 200, body: { success: true } as Record<string, unknown> },
  calls: [] as string[],
}));

import { UserGeoAccessSection as GeoLive, UserPhoneField as PhoneLive } from './UserAccessSections';
import { UserGeoAccessSection as GeoOnMain, UserPhoneField as PhoneOnMain } from './UserAccessSections.as-on-main.test';

beforeEach(() => {
  h.countries = [
    { id: 'c1', name: 'سوريا', stores: [{ id: 's1', name: 'متجر الشام' }, { id: 's2', name: 'متجر حلب' }] },
    { id: 'c2', name: 'الأردن', stores: [] },
  ];
  h.access = { countryIds: ['c2'], storeIds: [] };
  h.loadFails = false;
  h.write = { status: 200, body: { success: true } };
  h.calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      h.calls.push(`${method} ${url} ${init?.body ?? ''}`);
      const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
      if (method !== 'GET') return ok(h.write.body, h.write.status);
      if (h.loadFails) return ok({}, 500);
      if (url === '/api/geo/countries') return ok({ countries: h.countries });
      return ok(h.access);
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
const box = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const census = () => ({
  buttons: screen.queryAllByRole('button').length,
  checkboxes: screen.queryAllByRole('checkbox').length,
  locked: screen.queryAllByRole('checkbox').filter((b) => (b as HTMLInputElement).disabled).length,
  ticked: screen.queryAllByRole('checkbox').filter((b) => (b as HTMLInputElement).checked).length,
  fields: screen.queryAllByRole('textbox').length,
});

async function run(ui: React.ReactElement, script: (user: User, last: (p: () => Promise<void>) => Promise<void>) => Promise<void>) {
  h.calls = [];
  const user = userEvent.setup();
  render(ui);
  let seen: ReturnType<typeof census> | null = null;
  await script(user, async (p) => {
    seen = census();
    await p();
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const out = { calls: [...h.calls], seen, text: document.body.textContent };
  cleanup();
  return out;
}

async function same(before: React.ReactElement, after: React.ReactElement, script: Parameters<typeof run>[1], expectWrite: RegExp | null) {
  const a = await run(before, script);
  const b = await run(after, script);
  if (expectWrite) expect(a.calls.some((c) => expectWrite.test(c)), a.calls.join('\n')).toBe(true);
  expect(b.calls).toEqual(a.calls);
  expect(b.seen).toEqual(a.seen);
  return { before: a, after: b };
}

const save = (user: User) => user.click(screen.getByRole('button', { name: /احفظ الوصول/ }));

describe('the countries and stores send exactly what they sent on main', () => {
  it('a store ticks its country; a country off takes its stores; back on; a second store; another country off — then PUT', async () => {
    await same(<GeoOnMain userId="u7" canEdit />, <GeoLive userId="u7" canEdit />, async (user, last) => {
      await waitFor(() => expect(box(/^سوريا/)).toBeTruthy());
      await user.click(box(/متجر الشام/));
      expect(box(/^سوريا/).checked).toBe(true);
      await user.click(box(/^سوريا/));
      expect(box(/متجر الشام/).checked).toBe(false);
      await user.click(box(/^سوريا/));
      await user.click(box(/متجر حلب/));
      await user.click(box(/^الأردن/));
      await last(() => save(user));
      await screen.findByText(/حُفظ الوصول/);
    }, /^PUT \/api\/users\/u7\/geo-access \{"countryIds":\["c1"\],"storeIds":\["s2"\]\}$/);
  });

  it('a refused save says the door\'s sentence in both', async () => {
    h.write = { status: 403, body: { error: 'ما إلك صلاحية' } };
    const r = await same(<GeoOnMain userId="u7" canEdit />, <GeoLive userId="u7" canEdit />, async (user, last) => {
      await waitFor(() => expect(box(/^سوريا/)).toBeTruthy());
      await user.click(box(/^سوريا/));
      await last(async () => {
        await save(user);
        await screen.findByText('ما إلك صلاحية');
      });
    }, /^PUT /);
    expect(r.after.text).toContain('ما إلك صلاحية');
  });

  it('NEGATIVE: without the edit key every box is locked, a press changes nothing, and no save is drawn or sent', async () => {
    const r = await same(<GeoOnMain userId="u7" canEdit={false} />, <GeoLive userId="u7" canEdit={false} />, async (user, last) => {
      await waitFor(() => expect(box(/^الأردن/)).toBeTruthy());
      await user.click(box(/^سوريا/));
      await last(async () => {
        expect(screen.queryByRole('button', { name: /احفظ الوصول/ })).toBeNull();
      });
    }, null);
    expect(r.after.seen).toMatchObject({ checkboxes: 4, locked: 4, ticked: 1, buttons: 0 });
    expect(r.after.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('a load that fails says so in both, and draws no box', async () => {
    h.loadFails = true;
    const r = await same(<GeoOnMain userId="u7" canEdit />, <GeoLive userId="u7" canEdit />, async (_user, last) => {
      await screen.findByText('تعذّر تحميل البلدان والمتاجر.');
      await last(async () => {});
    }, null);
    expect(r.after.seen).toMatchObject({ checkboxes: 0 });
  });
});

describe('every box on the live section is its own', () => {
  it('ids carry the person and the country or store, are unique, and each label ticks its own box only', async () => {
    const user = userEvent.setup();
    render(<GeoLive userId="u7" canEdit />);
    await waitFor(() => expect(box(/^سوريا/)).toBeTruthy());
    const all = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(all.map((b) => b.id)).toEqual(['geo-u7-country-c1', 'geo-u7-store-s1', 'geo-u7-store-s2', 'geo-u7-country-c2']);
    for (const b of all) expect(b.labels?.[0]?.control, b.id).toBe(b);
    // The words of the second store tick that store (and its country, as on main) — never the first store.
    await user.click(screen.getByText('متجر حلب'));
    expect(all.map((b) => b.checked)).toEqual([true, false, true, true]);
  });
});

describe('the phone sends exactly what it sent on main', () => {
  it('a corrected number is trimmed and PATCHed with the same action', async () => {
    await same(<PhoneOnMain userId="u7" initial="000 000" canEdit />, <PhoneLive userId="u7" initial="000 000" canEdit />, async (user, last) => {
      const field = screen.getByRole('textbox', { name: 'هاتف الموظف' });
      await user.clear(field);
      await user.type(field, '  111 222 ');
      await last(() => user.click(screen.getByRole('button', { name: 'حفظ' })));
      await screen.findByText('حُفظ.');
    }, /^PATCH \/api\/users\/u7 \{"action":"updateContact","phone":"111 222"\}$/);
  });

  it('NEGATIVE: without the edit key there is no field and no save', async () => {
    const r = await same(<PhoneOnMain userId="u7" initial="000 000" canEdit={false} />, <PhoneLive userId="u7" initial="000 000" canEdit={false} />, async (_user, last) => {
      await last(async () => {});
    }, null);
    expect(r.after.seen).toMatchObject({ fields: 0, buttons: 0 });
    expect(r.after.calls).toEqual([]);
  });
});
