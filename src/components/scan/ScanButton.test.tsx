// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE CAMERA IS A BORROWED RESOURCE.
 *
 * Everything in this file is about the two ways a scanner goes wrong in a
 * warehouse rather than on a desk:
 *
 *   It keeps the lens. The sheet closes, the stream does not stop, the
 *   phone's camera light stays on, and the next screen that asks for the
 *   camera is refused — by our own tab.
 *
 *   It counts wrong. A camera reads thirty frames a second and a parcel
 *   sits in front of it for two, so one parcel is received fifteen times.
 *
 * Both are invisible in a demo and obvious on a Thursday afternoon.
 */

/** What the fake lens will decode on the next frame. */
let decoded: { text: string; format: 'qr' | 'barcode' } | null = null;
const readerClosed = vi.fn();

vi.mock('@/lib/scanning', async (importOriginal) => ({
  // cleanScan and RecentScans stay REAL — they are half of what is under
  // test here, and mocking them would prove only that the mock works.
  ...(await importOriginal<typeof import('@/lib/scanning')>()),
  makeReader: async () => ({
    reader: { read: async () => decoded, close: readerClosed },
    native: true,
  }),
}));

import { ScanButton, ScanSheet } from './ScanButton';

let tracks: { stop: ReturnType<typeof vi.fn>; getCapabilities?: () => unknown; applyConstraints?: unknown }[] = [];
/** Typed so the three shapes it takes across these tests all fit. */
type Gum = ReturnType<typeof vi.fn<(constraints?: unknown) => Promise<unknown>>>;
let getUserMedia: Gum;

function makeTrack(caps: Record<string, unknown> = {}) {
  return {
    stop: vi.fn(),
    getCapabilities: () => caps,
    applyConstraints: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  decoded = null;
  readerClosed.mockClear();
  tracks = [makeTrack()];
  getUserMedia = vi.fn(async (): Promise<unknown> => ({
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
  }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: (...a: unknown[]) => getUserMedia(...a) },
  });

  // jsdom has no video pipeline and no canvas. The component only needs a
  // frame that is "big enough to be worth reading" and somewhere to put it.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: async () => undefined });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ drawImage: vi.fn() }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sheet = (props: Partial<React.ComponentProps<typeof ScanSheet>> = {}) => (
  <ScanSheet
    title="مسح"
    onClose={props.onClose ?? vi.fn()}
    onScan={props.onScan ?? vi.fn()}
    continuous={props.continuous ?? false}
    clean={props.clean}
  />
);

describe('opening the camera', () => {
  it('asks for the rear lens, as a preference and not a demand', async () => {
    // `exact` here is a laptop that gets no scanner at all.
    await act(async () => {
      render(sheet());
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia.mock.calls[0][0]).toEqual({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  });

  it('shows the torch only when the lamp actually exists', async () => {
    await act(async () => {
      render(sheet());
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(screen.queryByText('الإضاءة')).toBeNull();
  });

  it('and shows it when it does', async () => {
    tracks = [makeTrack({ torch: true })];
    await act(async () => {
      render(sheet());
    });
    expect(await screen.findByText('الإضاءة')).toBeTruthy();
  });
});

describe('letting the camera go', () => {
  it('stops every track when the sheet is closed', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(sheet({ onClose }));
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByLabelText('إغلاق'));
    });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(readerClosed).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('and stops them when the screen is navigated away from instead', async () => {
    // The exit nobody writes code for: React unmounts the tree and no
    // handler of ours ran. Without the cleanup the lens stays held.
    const { unmount } = render(sheet());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await act(async () => {
      unmount();
    });
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('and stops a stream that arrived after the sheet had already closed', async () => {
    // Somebody taps the camera and closes it before the permission prompt
    // resolves. The stream still arrives, to a component that is gone.
    let hand: ((v: unknown) => void) | null = null;
    getUserMedia = vi.fn(() => new Promise<unknown>((resolve) => (hand = resolve)));
    const { unmount } = render(sheet());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await act(async () => {
      unmount();
    });
    await act(async () => {
      hand!({ getTracks: () => tracks, getVideoTracks: () => tracks });
    });
    await waitFor(() => expect(tracks[0].stop).toHaveBeenCalled());
  });
});

describe('reading a label', () => {
  it('hands the screen the code, and closes when one is all that was wanted', async () => {
    const onScan = vi.fn();
    const onClose = vi.fn();
    decoded = { text: 'sy-2026-0148', format: 'qr' };
    await act(async () => {
      render(sheet({ onScan, onClose }));
    });
    // Normalised on the way through — the same string a typed search sends.
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('SY-2026-0148'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('receives one parcel once, however many frames it sat still for', async () => {
    const onScan = vi.fn();
    decoded = { text: 'SY-2026-0148', format: 'qr' };
    await act(async () => {
      render(sheet({ onScan, continuous: true }));
    });
    await waitFor(() => expect(onScan).toHaveBeenCalledTimes(1));
    // Several more frames of the same parcel.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('stays open in continuous mode — a pallet is twenty parcels, not one', async () => {
    const onClose = vi.fn();
    decoded = { text: 'SY-2026-0148', format: 'qr' };
    await act(async () => {
      render(sheet({ onClose, continuous: true }));
    });
    await waitFor(() => expect(screen.getByTestId('scan-said')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says back what the screen answered, not just the code', async () => {
    decoded = { text: 'SY-2026-0148', format: 'qr' };
    await act(async () => {
      render(sheet({ continuous: true, onScan: () => '⚠ ليس من هذه الدفعة' }));
    });
    await waitFor(() => expect(screen.getByTestId('scan-said').textContent).toBe('⚠ ليس من هذه الدفعة'));
  });
});

/**
 * THE GUARD. A QR is a thing anybody can print and leave on a shelf.
 */
describe('what the lens is not allowed to pass on', () => {
  it('never hands the screen a URL found in a QR', async () => {
    const onScan = vi.fn();
    decoded = { text: 'https://example.com/orders/1', format: 'qr' };
    await act(async () => {
      render(sheet({ onScan, continuous: true }));
    });
    await waitFor(() => expect(screen.getByTestId('scan-said').textContent).toBe('هذا ليس مرجعاً نعرفه.'));
    expect(onScan).not.toHaveBeenCalled();
  });

  it('and refuses the same thing when it is typed by hand', async () => {
    // One validation, one path. Two entry points with two rules is how a
    // rule ends up enforced on one of them.
    const onScan = vi.fn();
    await act(async () => {
      render(sheet({ onScan, continuous: true }));
    });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('أو اكتب المرجع'), { target: { value: '{"id":1}' } });
      fireEvent.click(screen.getByText('إدخال'));
    });
    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-said').textContent).toBe('هذا ليس مرجعاً نعرفه.');
  });

  // 19/11: the public authenticity page's QR holds a whole link. The warehouse rule refused it («هذا ليس مرجعاً
  // نعرفه»); that page now hands the sheet its own cleaner, and every other caller keeps the default.
  const LINK = 'https://crm.zakiai.io/verify/168f776f-7144-4422-864d-e63ac8c6ddc8?code=P-00042';

  it('by default a link is not a reference — the warehouse rule is unchanged', async () => {
    const onScan = vi.fn();
    await act(async () => {
      render(sheet({ onScan, continuous: true }));
    });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('أو اكتب المرجع'), { target: { value: LINK } });
      fireEvent.click(screen.getByText('إدخال'));
    });
    expect(onScan).not.toHaveBeenCalled();
  });

  it('a caller that passes its own cleaner gets what that cleaner keeps — the link, exactly', async () => {
    const onScan = vi.fn();
    await act(async () => {
      render(sheet({ onScan, continuous: true, clean: (raw) => raw.trim() || null }));
    });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('أو اكتب المرجع'), { target: { value: `  ${LINK}  ` } });
      fireEvent.click(screen.getByText('إدخال'));
    });
    expect(onScan).toHaveBeenCalledWith(LINK);
  });
});

describe('when there is no camera to be had', () => {
  it('says why, and the work still continues by hand', async () => {
    getUserMedia = vi.fn(async (): Promise<unknown> => {
      const e = new Error('denied');
      e.name = 'NotAllowedError';
      throw e;
    });
    const onScan = vi.fn();
    await act(async () => {
      render(sheet({ onScan, continuous: true }));
    });
    expect(await screen.findByText(/الكاميرا مرفوضة/)).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('أو اكتب المرجع'), { target: { value: 'sy-2026-0148' } });
      fireEvent.click(screen.getByText('إدخال'));
    });
    expect(onScan).toHaveBeenCalledWith('SY-2026-0148');
  });

  it('and says something different when the device simply has none', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    await act(async () => {
      render(sheet());
    });
    expect(await screen.findByText(/لا كاميرا متاحة/)).toBeTruthy();
  });
});

describe('the trigger', () => {
  it('opens nothing until it is pressed — no screen holds a camera it is not using', async () => {
    await act(async () => {
      render(<ScanButton onScan={vi.fn()} />);
    });
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('مسح'));
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  });
});

/**
 * THE LENS IS BORROWED ONCE, NOT ONCE PER RENDER.
 *
 * `accept` used to depend on the `onScan` and `onClose` props, and the effect
 * that opens the camera depends on `accept`. Every call site passes
 * `onScan={(code) => {…}}` written in place, so each render of the screen
 * above produced a new identity, re-ran the effect, and its cleanup calls
 * `release()` — which STOPS THE VIDEO TRACKS and closes the reader — before
 * asking the browser for the camera again.
 *
 * A screen that polls therefore handed the camera back and re-borrowed it
 * every few seconds, while somebody held a parcel in front of it.
 */
describe('a screen that re-renders while the sheet is open', () => {
  it('does not hand the camera back and ask for it again', async () => {
    function Host() {
      const [, bump] = React.useState(0);
      return (
        <>
          <button onClick={() => bump((n) => n + 1)}>ارسم</button>
          {/* Written in place, exactly as all three real call sites do. */}
          <ScanSheet title="مسح" onClose={() => {}} onScan={async () => undefined} continuous={false} />
        </>
      );
    }

    await act(async () => {
      render(<Host />);
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(screen.getByText('ارسم'));
      });
    }

    expect(getUserMedia, 'طُلبت الكاميرا مرّةً أخرى عند كلِّ رسمة').toHaveBeenCalledTimes(1);
    expect(tracks[0].stop, 'أُوقف بثُّ الكاميرا والورقة ما زالت مفتوحة').not.toHaveBeenCalled();
    expect(readerClosed, 'أُغلق القارئ والورقة ما زالت مفتوحة').not.toHaveBeenCalled();
  });
});
