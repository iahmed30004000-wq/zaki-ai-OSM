'use client';

import React, { useState, useSyncExternalStore } from 'react';
import { RiInstallLine } from '@remixicon/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

/**
 * «زر تثبيت تطبيق باللاب و التلفون ضروري».
 *
 * The app was already installable — a manifest, three icons, a worker —
 * and nothing on any screen said so. Chrome hides its own offer behind an
 * icon in the address bar that nobody looks at, and Safari offers nothing
 * at all: on an iPhone the only way is a menu item three taps deep.
 *
 * So the system says it itself, in the one of three ways this browser has:
 *
 *   'prompt'     Chrome, Edge, Android — the browser hands us its install
 *                dialog (`beforeinstallprompt`) and one tap opens it.
 *   'ios'        iPhone and iPad, every browser — there is no dialog to
 *                open, so the button opens the steps instead.
 *   'mac-safari' Safari on a Mac — the same, through the File menu.
 *
 * Anywhere else (Firefox, or a Chrome that has not offered yet) nothing is
 * drawn: a button that cannot do anything is worse than none. Once the app
 * is installed — or this page IS the installed app — nothing is drawn
 * either.
 */
export type InstallWay = 'prompt' | 'ios' | 'mac-safari' | null;

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/*
 * THE OFFER IS CAUGHT AT IMPORT, NOT AT MOUNT.
 *
 * Chrome fires `beforeinstallprompt` once per page load, whenever it is
 * ready — and it may be ready before the header has hydrated. A listener
 * added in an effect would miss it, and the button would never appear on
 * exactly the fast connection where it should. The shell imports this
 * module, so the listener is on the window as early as the shell's code is.
 */
let offer: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Our button takes the place of Chrome's own bar on Android.
    e.preventDefault();
    offer = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    offer = null;
    emit();
  });
}

/** This page is the installed app, opened from its icon. */
function standalone(): boolean {
  const mm = typeof window.matchMedia === 'function' ? window.matchMedia : null;
  return (
    !!mm?.('(display-mode: standalone)').matches ||
    !!mm?.('(display-mode: window-controls-overlay)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** The browsers that can install but never offer. */
function platformWay(): InstallWay {
  const ua = navigator.userAgent;
  // An iPad says «Macintosh» since iPadOS 13; its touch screen is what gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\/|OPR\//.test(ua)) {
    return 'mac-safari';
  }
  return null;
}

function currentWay(): InstallWay {
  if (installed || standalone()) return null;
  return offer ? 'prompt' : platformWay();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Nothing on the server: whether a browser can install is the browser's to say. */
const onServer = (): InstallWay => null;

/**
 * Which way this browser installs, and the thing to do about it.
 *
 * `install()` opens the browser's dialog when there is one. The offer is
 * single-use — Chrome refuses a second `prompt()` on the same event — so it
 * is dropped either way, and the button goes until the browser offers
 * again on a later page load.
 */
export function useInstallApp() {
  const way = useSyncExternalStore(subscribe, currentWay, onServer);
  const [steps, setSteps] = useState(false);

  const install = async () => {
    if (!offer) {
      setSteps(true);
      return;
    }
    const used = offer;
    offer = null;
    await used.prompt();
    const { outcome } = await used.userChoice;
    if (outcome === 'accepted') installed = true;
    emit();
  };

  return { way, install, steps, closeSteps: () => setSteps(false) };
}

/** The steps, for the two browsers that have no dialog to open. */
function InstallSteps({ way, open, onClose }: { way: InstallWay; open: boolean; onClose: () => void }) {
  return (
    <Modal isOpen={open} onClose={onClose} title="تثبيت التطبيق" maxWidth="sm">
      {way === 'mac-safari' ? (
        <ol className="space-y-2 text-sm text-[var(--sys-foreground)]">
          <li>1. من القائمة في أعلى الشاشة، اضغط «ملف».</li>
          <li>2. اختر «إضافة إلى Dock».</li>
          <li>3. اضغط «إضافة»، فيصبح النظام تطبيقاً بأيقونة على الـDock.</li>
        </ol>
      ) : (
        <>
          <ol className="space-y-2 text-sm text-[var(--sys-foreground)]">
            <li>1. اضغط زر المشاركة: المربّع الذي فيه سهم إلى الأعلى، أسفل الشاشة أو أعلاها.</li>
            <li>2. مرّر القائمة واختر «إضافة إلى الشاشة الرئيسية».</li>
            <li>3. اضغط «إضافة»، فتظهر أيقونة النظام على شاشتك مثل أي تطبيق.</li>
          </ol>
          <p className="mt-3 text-note text-[var(--sys-muted-foreground)]">
            إذا لم تجد «إضافة إلى الشاشة الرئيسية»، افتح الرابط في سفاري وحاول مرة أخرى.
          </p>
        </>
      )}
    </Modal>
  );
}

/**
 * THE HEADER'S BUTTON — laptop and tablet.
 *
 * Not on a phone: that bar is already the bell, the counts and the search,
 * and its own comment is the reason it stays that way. The phone gets the
 * strip below and a line in «المزيد».
 */
export function InstallAppButton() {
  const { way, install, steps, closeSteps } = useInstallApp();
  if (!way) return null;
  return (
    <>
      {/* Hidden on a phone by a wrapper: the kit's button always shows
          itself as an inline box, and the sheet writes that rule after the
          one that hides. */}
      <span className="hidden md:flex shrink-0">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void install()}
          title="ثبّت النظام كتطبيق بأيقونة خاصة فيه"
        >
          <RiInstallLine className="w-4 h-4 shrink-0" aria-hidden />
          ثبّت التطبيق
        </Button>
      </span>
      <InstallSteps way={way} open={steps} onClose={closeSteps} />
    </>
  );
}

/** The line in the phone's «المزيد» sheet: always there while installing is possible. */
export function InstallAppLine({ className }: { className: string }) {
  const { way, install, steps, closeSteps } = useInstallApp();
  if (!way) return null;
  return (
    <>
      <button type="button" onClick={() => void install()} className={className}>
        <RiInstallLine className="h-4 w-4 shrink-0" aria-hidden />
        ثبّت التطبيق على هاتفك
      </button>
      <InstallSteps way={way} open={steps} onClose={closeSteps} />
    </>
  );
}

const LATER_KEY = 'zaki.install.later';
/** «ليس الآن» rests the strip for this long; the line in «المزيد» stays. */
const LATER_MS = 14 * 24 * 60 * 60 * 1000;

function resting(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Date.now() - (Number(localStorage.getItem(LATER_KEY)) || 0) < LATER_MS;
  } catch {
    return false;
  }
}

/**
 * THE PHONE'S STRIP — the offer seen without opening anything.
 *
 * A line inside «المزيد» is a line nobody opens a sheet to look for. So the
 * phone also gets this, once, above the page: what installing gives, a
 * button, and «ليس الآن», which rests it for two weeks on this phone.
 */
export function InstallAppStrip() {
  const { way, install, steps, closeSteps } = useInstallApp();
  const [later, setLater] = useState(resting);
  if (!way || later) return null;

  const rest = () => {
    try {
      localStorage.setItem(LATER_KEY, String(Date.now()));
    } catch {
      // Private mode: it rests for this visit only.
    }
    setLater(true);
  };

  return (
    <div role="region" aria-label="تثبيت التطبيق" className="md:hidden flex items-center gap-3 border-b border-[var(--sys-border)] bg-[var(--sys-card)] px-4 py-3">
      <RiInstallLine className="h-5 w-5 shrink-0 text-[var(--sys-primary)]" aria-hidden />
      <p className="flex-1 text-sm text-[var(--sys-foreground)]">ثبّت النظام على هاتفك ليفتح من أيقونة وبملء الشاشة.</p>
      <Button size="sm" onClick={() => install()}>
        ثبّت
      </Button>
      <Button size="sm" variant="quiet" onClick={rest}>
        ليس الآن
      </Button>
      <InstallSteps way={way} open={steps} onClose={closeSteps} />
    </div>
  );
}
