// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «متابعة الشحن» — A SCAN BUTTON BESIDE THE SEARCH, THE SAME ONE THE OTHER SCREENS HAVE.
 *
 * The owner, 11/11: «بدي أحط زر جنب البحث مسح باركود او QR». The scanner already existed (`components/scan/ScanButton`: the camera, the
 * permission, the decoder, the release — in ONE place); the orders screen and the returns screen use it. What this screen owes:
 *
 *   · the button is drawn beside the search box, on the box's own line, with a thumb-sized height;
 *   · a code the camera reads goes INTO THE SAME BOX a person types into, and the same question goes to the server — a scan is a
 *     search, so it sees exactly the parcels the account may see and opens nothing by itself;
 *   · one scan finds one parcel, so the sheet is not the continuous kind (that is the returns desk, receiving twenty);
 *   · the camera is not touched until somebody presses the button;
 *   · and this screen holds no scanner of its own: it imports the shared one.
 */

const { api, search, scanned } = vi.hoisted(() => ({
  api: vi.fn(),
  search: { value: '' },
  scanned: { props: null as null | { onScan: (code: string) => unknown; title?: string; continuous?: boolean; className?: string } },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>متابعة الشحن</h1> }));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => async () => true,
  useTell: () => async () => undefined,
}));
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/components/screens/tracking/WriteOffDialog', () => ({ WriteOffDialog: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
// The REAL button, wrapped only to read the props this screen hands it.
vi.mock('@/components/scan/ScanButton', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/scan/ScanButton')>();
  return {
    ...real,
    ScanButton: (props: NonNullable<typeof scanned.props>) => {
      scanned.props = props;
      return <real.ScanButton {...props} />;
    },
  };
});

import { TrackingScreen } from './TrackingScreen';

const NO_TASKS = { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 };
const FACTS = { total: 1, tasks: NO_TASKS, lateCount: 0, couriers: [], regions: [], ages: { fresh: 1, few: 0, week: 0, old: 0 } };
const PARCEL = {
  id: '11111111-1111-4111-8111-111111111111',
  orderNumber: 'ORD-P1',
  merchantRef: null,
  trackingNumber: 'TRK-P1',
  shippingStatus: 'SHIPPED',
  collectionStatus: 'NOT_APPLICABLE',
  settlementStatus: 'NOT_APPLICABLE',
  daysInTransit: 1,
  lateThresholdDays: 3,
  late: false,
  totalAmount: 40,
  currency: 'JOD',
  deliveryFailureReason: null,
  customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
  region: { name: 'عمّان' },
  deliveryProvider: null,
  expectedCollection: 37.5,
  _count: { deliveryAttempts: 0, notes: 0 },
  alert: null,
};

const gets = () =>
  api.mock.calls.filter((c) => !(c[1] && (c[1] as RequestInit).method)).map((c) => new URL(c[0] as string, 'http://x').searchParams);
const posts = () => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method);
const box = () => screen.getByLabelText('بحث') as HTMLInputElement;
const trigger = () => screen.getByRole('button', { name: /مسح/ });

const getUserMedia = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  search.value = '';
  scanned.props = null;
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  api.mockImplementation(async () => ({
    count: 1,
    orders: [PARCEL],
    lateCount: 0,
    dialCode: '962',
    pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
    facts: FACTS,
    applied: {},
    capped: false,
  }));
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TrackingScreen />);
  // The number is drawn once for a desk and once for a phone: «more than one» is the right answer, none is not.
  await screen.findAllByText('ORD-P1');
};

describe('the button beside the search', () => {
  it('is drawn on the search box’s own row, as the box’s next sibling, and says what it does', async () => {
    await draw();
    const row = box().closest('div.relative.max-w-md')!.parentElement!;
    expect(row).toBeTruthy();
    expect(trigger().parentElement).toBe(row);
    expect(trigger().previousElementSibling).toBe(box().closest('div.relative.max-w-md'));
    expect(scanned.props?.title).toBe('امسح بوليصة الشحنة — QR أو باركود');
  });

  it('is a thumb-sized control that sits on the input’s line, not between the label and the input', async () => {
    await draw();
    const said = scanned.props?.className ?? '';
    expect(said).toMatch(/(?<![\w-])h-11 md:h-10(?![\w-])/);
    expect(said).toMatch(/(?<![\w-])self-end(?![\w-])/);
    expect(said).toMatch(/(?<![\w-])shrink-0(?![\w-])/);
  });

  it('is the one-shot kind: a scan finds one parcel and the sheet closes (the returns desk is the continuous one)', async () => {
    await draw();
    expect(scanned.props?.continuous).not.toBe(true);
  });

  it('is there before the first answer comes — a screen people find a parcel on must not open without it', async () => {
    api.mockImplementation(() => new Promise(() => undefined));
    render(<TrackingScreen />);
    expect(trigger()).toBeTruthy();
    expect(box()).toBeTruthy();
  });
});

describe('what a scan does', () => {
  it('puts the code in the SAME box and asks the server that one word, from page one — exactly what typing it would do', async () => {
    await draw();
    expect(gets()).toHaveLength(1);
    await act(async () => {
      scanned.props!.onScan('SY-019461');
    });
    await waitFor(() => expect(box().value).toBe('SY-019461'));
    await waitFor(() => expect(gets().at(-1)!.get('q')).toBe('SY-019461'));
    expect(gets().at(-1)!.get('page')).toBe('1');
  });

  it('NEGATIVE: a scan only searches — nothing is posted, nothing is opened, no state of any parcel is touched', async () => {
    await draw();
    await act(async () => {
      scanned.props!.onScan('SY-019461');
    });
    await waitFor(() => expect(gets().at(-1)!.get('q')).toBe('SY-019461'));
    expect(posts()).toHaveLength(0);
  });

  it('a second scan replaces the first in the box, and «إعادة تعيين» is offered because a word now narrows the list', async () => {
    await draw();
    await act(async () => {
      scanned.props!.onScan('SY-019461');
    });
    await waitFor(() => expect(box().value).toBe('SY-019461'));
    await act(async () => {
      scanned.props!.onScan('SY-019464');
    });
    await waitFor(() => expect(box().value).toBe('SY-019464'));
    expect(await screen.findByRole('button', { name: /إعادة تعيين/ })).toBeTruthy();
  });
});

describe('the camera', () => {
  it('NEGATIVE: opening the screen does not touch the camera — only pressing the button does', async () => {
    await draw();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe('one scanner, not two', () => {
  it('the screen imports the shared button and holds no decoder, camera or stream of its own', () => {
    const source = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/TrackingScreen.tsx'), 'utf8'));
    expect(source).toMatch(/from '@\/components\/scan\/ScanButton'/);
    for (const own of ['getUserMedia', 'BarcodeDetector', '@zxing', 'MediaStream', 'mediaDevices']) {
      expect(source.includes(own), `الشاشة ما بتحمل ${own} — الماسح واحد مشترك`).toBe(false);
    }
  });
});
