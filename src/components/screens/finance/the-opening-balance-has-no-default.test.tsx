// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * A THIRD COPY OF A REAL DEFAULT — THE WHOLE ROUND TRIP.
 *
 * `WalletsScreen`'s create dialog sent
 *
 *     openingBalance: opening ? Number(opening) : 0
 *
 * This is a RELOCATED default rather than an invented one, which is what
 * made it worth checking instead of deleting: the `0` agrees with the column
 * (`schema.prisma`: `openingBalance Decimal @default(0)`) and with the
 * door's zod (`wallets/route.ts`: `.default(0)`). So nothing wrong was
 * stored by it. What it did was answer the door's question before the door
 * could see it, from a third place — and «absent» and «zero» are then the
 * same request on the wire, so the day the default moves, two of the three
 * copies move with it and this one does not.
 *
 * `JSON.stringify` DROPS an `undefined` property, so an empty box is now
 * ABSENT and the door's `.default(0)` decides. The pattern `17cbe93` and
 * `509306a` established in `CourierFees` and `ManufacturingScreen`.
 *
 * THESE ASSERT THE JSON ON THE WIRE AND THE ROW HANDED TO PRISMA — never the
 * text of an expression — and they join the two halves the way
 * `the-expense-box-has-no-default.test.tsx` does: the real dialog is
 * rendered, the body it actually sent is captured, and THAT EXACT BODY is
 * handed to the real `POST /api/finance/wallets`.
 *
 *   · dialog opened, box untouched      → `openingBalance` ABSENT → 201, row 0
 *   · a typed 4350.5                    → 4350.5 on the wire     → 201, row 4350.5
 *   · a typed 0                         → 0 on the wire          → 201, row 0
 *   · the box filled then cleared       → absent again           → 201, row 0
 *
 * Put `opening ? Number(opening) : 0` back and the first and fourth read
 * `0` where they expect the key to be missing.
 */

/* ── the door's dependencies ───────────────────────────────────────────── */

const { db, requireContext, requirePermission, can, logAudit } = vi.hoisted(() => ({
  db: {
    wallet: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    country: { findFirst: vi.fn() },
    walletMovement: { groupBy: vi.fn(), findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

/* ── the screen's dependencies ─────────────────────────────────────────── */

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['finance.cashbox_view', 'finance.cashbox', 'finance.wallets_manage'] } }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المحافظ</h1> }));

import { POST as WALLETS } from '@/app/api/finance/wallets/route';
import { WalletsScreen } from './WalletsScreen';

const COUNTRY = { id: '77777777-7777-4777-8777-777777777777', name: 'الأردن', currencyCode: 'JOD' };

/** Every non-GET body the screen sent, in order. */
let sent: { url: string; body: any }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];

  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سامر' },
    companyId: 'co1',
    storeId: '66666666-6666-4666-8666-666666666666',
  });
  requirePermission.mockResolvedValue(undefined);
  can.mockResolvedValue(true);
  db.country.findFirst.mockResolvedValue({ id: COUNTRY.id, name: COUNTRY.name });
  db.wallet.findFirst.mockResolvedValue(null); // no name clash
  db.wallet.create.mockImplementation(async ({ data }: any) => ({ id: 'w-new', ...data }));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (method !== 'GET') {
        sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        // The screen only needs a shape back. The DOOR's answer comes from
        // the real handler below, never from this stub.
        return json({ wallet: { id: 'w-new' } }, 201);
      }
      if (url.startsWith('/api/geo/countries')) return json({ countries: [COUNTRY] });
      if (url.includes('/movements')) return json({ movements: [] });
      return json({ wallets: [] });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ── driving the real dialog ───────────────────────────────────────────── */

/** The opening-balance box: the only `type="number"` box in this dialog. */
const openingBox = () =>
  document.querySelector('input[type="number"][step="0.001"]') as HTMLInputElement;

/** Open «محفظة جديدة», do `fill`, submit, and return THE BODY SENT. */
async function bodyFor(fill: (u: ReturnType<typeof userEvent.setup>) => Promise<void>) {
  const user = userEvent.setup();
  render(<WalletsScreen />);
  await user.click(await screen.findByText('محفظة جديدة'));
  await waitFor(() => expect(openingBox()).toBeTruthy());
  // The country list arrives by its own fetch, and a company with exactly
  // one country has it chosen for it — with the country's currency. The
  // submit button is disabled until then (`disabled={saving || !countryId}`),
  // so waiting on that is waiting on the real precondition.
  await waitFor(() => expect(screen.getByText(`${COUNTRY.name} — ${COUNTRY.currencyCode}`)).toBeTruthy());
  await waitFor(() => expect((screen.getByText('إنشاء') as HTMLButtonElement).disabled).toBe(false));

  await user.type(screen.getByPlaceholderText('مثال: الصندوق النقدي، حساب البنك العربي'), 'الصندوق النقدي');
  await fill(user);

  const save = screen.getByText('إنشاء');
  (save.closest('form') as HTMLFormElement).noValidate = true;
  await user.click(save);
  await waitFor(() => expect(sent).toHaveLength(1));
  return sent[0].body;
}

/* ── handing the captured body to the real door ────────────────────────── */

const atTheDoor = (body: unknown) =>
  WALLETS(
    new Request('http://localhost/api/finance/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

/** The `data` the wallet row was created with. */
const createdWallet = () => db.wallet.create.mock.calls[0][0].data;
/** Every opening balance that reached Prisma, in order. */
const writtenOpenings = () => db.wallet.create.mock.calls.map((c: any) => c[0].data.openingBalance);

/* ════════════════════════════════════════════════════════════════════════
   THE BROWSER HALF — what the box puts on the wire.
   ════════════════════════════════════════════════════════════════════════ */

describe('the opening-balance box sends nothing when nothing was typed', () => {
  it('opens empty — there is no pre-filled balance', async () => {
    const user = userEvent.setup();
    render(<WalletsScreen />);
    await user.click(await screen.findByText('محفظة جديدة'));
    await waitFor(() => expect(openingBox()).toBeTruthy());
    expect(openingBox().value).toBe('');
  });

  it('and sends the key ABSENT rather than a zero this component chose', async () => {
    const body = await bodyFor(async () => {});
    // The old expression, evaluated on the value an empty box reports.
    const emptyBox = String('');
    expect(emptyBox ? Number(emptyBox) : 0, 'ما كان يُرسَل عن خانةٍ فارغة').toBe(0);
    expect(body.openingBalance, 'الصفرُ المنقولُ عاد إلى السلك').not.toBe(0);
    expect('openingBalance' in body, 'خانةٌ فارغةٌ أرسلت قيمة').toBe(false);
    expect(body.openingBalance).toBeUndefined();
    // And the rest of the form is intact, so the absence is this field's.
    expect(body.name).toBe('الصندوق النقدي');
    expect(body.countryId).toBe(COUNTRY.id);
    expect(body.currencyCode).toBe('JOD');
  });

  it('sends a typed balance as the number it is', async () => {
    const body = await bodyFor(async (u) => {
      await u.type(openingBox(), '4350.5');
    });
    expect(body.openingBalance).toBe(4350.5);
  });

  it('and a typed zero IS sent — zero is a value a person can mean', async () => {
    const body = await bodyFor(async (u) => {
      await u.type(openingBox(), '0');
    });
    expect('openingBalance' in body).toBe(true);
    expect(body.openingBalance).toBe(0);
  });

  it('and a box filled then cleared is absent again, not a zero', async () => {
    const body = await bodyFor(async (u) => {
      await u.type(openingBox(), '900');
      await u.clear(openingBox());
    });
    expect('openingBalance' in body, 'خانةٌ مُفرَّغةٌ أرسلت صفراً').toBe(false);
    expect(body.openingBalance).not.toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   THE ROUND TRIP — that same body, at the real door.
   ════════════════════════════════════════════════════════════════════════ */

describe('the door decides what an absent opening balance means', () => {
  it('an untouched box creates a wallet at the column default, and that default is 0', async () => {
    const body = await bodyFor(async () => {});
    const res = await atTheDoor(body);
    expect(res.status).toBe(201);
    expect(createdWallet().openingBalance).toBe(0);
    expect(createdWallet().name).toBe('الصندوق النقدي');
    expect(createdWallet().currencyCode).toBe('JOD');
  });

  it('a typed balance reaches the column digit for digit', async () => {
    const body = await bodyFor(async (u) => {
      await u.type(openingBox(), '4350.5');
    });
    const res = await atTheDoor(body);
    expect(res.status).toBe(201);
    expect(writtenOpenings()).toEqual([4350.5]);
  });

  it('a typed zero reaches the column as zero, same as absence — by the DOOR, not the browser', async () => {
    const body = await bodyFor(async (u) => {
      await u.type(openingBox(), '0');
    });
    const res = await atTheDoor(body);
    expect(res.status).toBe(201);
    expect(writtenOpenings()).toEqual([0]);
  });

  it('and a cleared box lands on the same 0 the schema declares', async () => {
    const body = await bodyFor(async (u) => {
      await u.type(openingBox(), '900');
      await u.clear(openingBox());
    });
    const res = await atTheDoor(body);
    expect(res.status).toBe(201);
    expect(writtenOpenings()).toEqual([0]);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   THE DOOR ON ITS OWN — what no `type="number"` box can send.
   ════════════════════════════════════════════════════════════════════════ */

const SOUND = { countryId: COUNTRY.id, name: 'حساب بنكي', currencyCode: 'JOD' };

describe('an opening balance that is not a number is refused rather than zeroed', () => {
  it('`null` — which is what `JSON.stringify` writes for a NaN — is refused', async () => {
    expect(JSON.stringify({ openingBalance: NaN })).toBe('{"openingBalance":null}');
    const res = await atTheDoor({ ...SOUND, openingBalance: null });
    expect(res.status).toBe(400);
    expect(writtenOpenings(), 'قيمةٌ ليست رقماً صارت صفراً في العمود').toEqual([]);
  });

  it("and '2,500' from an Arabic keyboard is refused, not stored as 2", async () => {
    const res = await atTheDoor({ ...SOUND, openingBalance: '2,500' });
    expect(res.status).toBe(400);
    expect(writtenOpenings()).toEqual([]);
  });

  it('and a negative opening balance is accepted — an overdrawn account is real', async () => {
    // From the column: `openingBalance Decimal @default(0)` with no check
    // constraint, and the door declares `.min(-1_000_000_000)`. This is
    // recorded rather than changed: a bank account in overdraft starts
    // below zero, and refusing it here would be a new rule.
    const res = await atTheDoor({ ...SOUND, openingBalance: -250.75 });
    expect(res.status).toBe(201);
    expect(writtenOpenings()).toEqual([-250.75]);
  });
});
