'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RiPhoneLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/Confirm';

/**
 * «مساعد الاتصال» — THE CARD ON «طلباتي» THAT PAIRS HER PHONE WITH THE ANDROID APP (docs/call-helper/CONTRACT.md).
 *
 * Paired, «اتصل» on every card opens the app: it places the call, reads the phone's call log when it ends and tells the
 * desk «رد — 2:13» or «ما رد — رنّ 25 ث», which the «شو صار؟» sheet shows and puts first. She still taps the answer.
 *
 * ── THE BUTTON IS A PLAIN LINK TO A CODE THAT IS ALREADY HERE ──
 *
 * Chrome opens an app from an `intent://` link only on the press itself; a link opened after an `await` may be refused
 * because the press is spent. So the one-time code is fetched when the card is drawn (and again a minute before its ten
 * minutes run out), and «اربط هذا التلفون» is an anchor to it. When the app is not installed, Chrome comes back here with
 * `#call-helper-install` and the card says to install it first.
 *
 * Only an Android phone pairs; anywhere else the card says so in one line. When she comes back from the app (the page is
 * visible again) the card asks once more, and tells the desk (`onChange`) when the pairing changed — the desk is read
 * again, and its call links appear or go.
 */

interface DeviceState {
  paired: boolean;
  deviceName: string | null;
}

interface PairCode {
  intentUrl: string;
  expiresAt: string;
}

const INSTALL_HASH = '#call-helper-install';
/** A code is fetched again this long before it runs out. */
const REFRESH_BEFORE_MS = 60 * 1000;

const LINK =
  'inline-flex items-center gap-1.5 h-11 md:h-8 px-2.5 rounded-lg border border-[var(--sys-border)] text-xs font-semibold text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)] transition-colors';

export function CallHelperCard({ onChange }: { onChange?: () => void }) {
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [android, setAndroid] = useState(false);
  const [code, setCode] = useState<PairCode | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [install, setInstall] = useState(false);
  const confirm = useConfirm();
  const pairedRef = useRef<boolean | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const readDevice = useCallback(async () => {
    try {
      const d = await apiJson<DeviceState>('/api/call-helper/device');
      if (typeof d?.paired !== 'boolean') throw new Error('not an answer of the device door');
      const was = pairedRef.current;
      pairedRef.current = d.paired;
      setDevice({ paired: d.paired, deviceName: d.deviceName });
      if (was !== null && was !== d.paired) onChangeRef.current?.();
    } catch {
      setDevice(null);
    }
  }, []);

  useEffect(() => {
    setAndroid(typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent));
    const seeHash = () => setInstall(window.location.hash === INSTALL_HASH);
    seeHash();
    window.addEventListener('hashchange', seeHash);
    void readDevice();
    const back = () => {
      if (document.visibilityState === 'visible') void readDevice();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('hashchange', seeHash);
      document.removeEventListener('visibilitychange', back);
    };
  }, [readDevice]);

  // The code, ready before the press — on an Android phone that is not paired.
  const wantsCode = android && device?.paired === false;
  useEffect(() => {
    if (!wantsCode) {
      setCode(null);
      return;
    }
    let live = true;
    let timer: number | undefined;
    const fetchCode = async () => {
      try {
        const c = await apiJson<PairCode>('/api/call-helper/pair-code', { method: 'POST' });
        if (!live) return;
        setCode(c);
        setSaid(null);
        const wait = Math.max(5_000, new Date(c.expiresAt).getTime() - Date.now() - REFRESH_BEFORE_MS);
        timer = window.setTimeout(() => void fetchCode(), wait);
      } catch (e) {
        if (!live) return;
        setCode(null);
        setSaid(e instanceof Error ? e.message : 'تعذّر تجهيز الربط');
      }
    };
    void fetchCode();
    return () => {
      live = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [wantsCode]);

  const unpair = async () => {
    const ok = await confirm({
      title: 'افصل التلفون عن مساعد الاتصال؟',
      body: '«اتصل» برجع يفتح الاتصال العادي، والتطبيق بينسى الربط. بترجعي تربطيه من هون بأي وقت.',
    });
    if (!ok) return;
    try {
      await apiJson('/api/call-helper/device', { method: 'DELETE' });
      setSaid(null);
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'تعذّر الفصل');
    }
    await readDevice();
  };

  if (!device) return null;

  return (
    <section
      aria-label="مساعد الاتصال"
      data-call-helper
      className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3 space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--sys-heading)]">
          <RiPhoneLine className="w-4 h-4" />
          مساعد الاتصال
        </p>
        {device.paired ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--sys-success)]">
              مربوط: <span dir="auto">{device.deviceName}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={unpair}>
              افصل
            </Button>
          </div>
        ) : android ? (
          code ? (
            <a href={code.intentUrl} className={LINK}>
              اربط هذا التلفون
            </a>
          ) : null
        ) : (
          <span className="text-xs text-[var(--sys-muted)]">من تلفون أندرويد بس</span>
        )}
      </div>
      {!device.paired && (
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          تطبيق على تلفونك بيتصل بالزبون من «اتصل» وبيقرا من سجل المكالمات إذا رد وقديش حكيتي — وإنتِ بتختاري الجواب.
        </p>
      )}
      {install && !device.paired && (
        <p role="status" className="text-xs text-[var(--sys-warning)]">
          التطبيق مش منزّل على هالتلفون — نزّلي «مساعد الاتصال» أول (من المسؤول)، وبعدين ارجعي اضغطي «اربط هذا التلفون».
        </p>
      )}
      {said && (
        <p role="alert" className="text-xs text-[var(--sys-destructive)]">
          {said}
        </p>
      )}
    </section>
  );
}
