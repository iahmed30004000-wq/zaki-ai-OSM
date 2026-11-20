'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanButton } from '@/components/scan/ScanButton';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';

/**
 * THE PUBLIC FACE OF ONE COMPANY'S AUTHENTICITY LIST.
 *
 * Reuses `ScanButton`/`ScanSheet` exactly as the warehouse screens do — the camera, the permission prompt, the decoder
 * and the manual-entry fallback are one piece of code, written once (`src/components/scan`). What this component adds is
 * only what a public visitor needs: one POST that answers `{ genuine: boolean }`, a short «checking» moment, and a full
 * verdict screen.
 *
 * 19/11 (owner): dressed like the owner's landing page «تحقق من أصالة منتجك» (`/lp/verify-original`). Its rules live in
 * `src/app/verify/layout.tsx`, every one prefixed `vf-`. The marks are inline SVG and not Remix icons on purpose: every
 * Remix icon used anywhere lands in one shared chunk that each staff screen downloads (`staff-confirmation-first-load`).
 */

type Phase = { at: 'start'; failed?: boolean } | { at: 'checking' } | { at: 'verdict'; genuine: boolean };

/** Long enough for the radar to read as a check rather than a flicker; the answer itself is usually faster. */
const CHECK_MS = 1800;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scattered points of light behind the hero, fixed so the server and the browser draw the same page. */
const DOTS = [
  [8, 82, 3, 1.3, 9.4], [53, 30, 4, 4.5, 8.3], [68, 62, 4.5, 1.5, 7.2], [90, 78, 2.4, 3.1, 10.5], [37, 34, 4.5, 2, 5.9],
  [30, 46, 3, 5.6, 8.3], [72, 86, 2.2, 1.6, 8.4], [18, 40, 3, 2.2, 7.5], [46, 84, 4, 3.8, 8.1], [62, 16, 3.4, 3.6, 5.8],
  [95, 56, 4, 1.6, 6.3], [26, 60, 3, 2, 7.3], [82, 22, 3.5, 0, 10.5], [4, 20, 2.6, 4.4, 7.9],
];

function Check() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function ShieldArt({ bad = false, id }: { bad?: boolean; id: string }) {
  return (
    <svg viewBox="0 0 120 140" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className={bad ? 'vf-r-s1' : 'vf-s1'} />
          <stop offset=".55" className={bad ? 'vf-r-s2' : 'vf-s2'} />
          <stop offset="1" className={bad ? 'vf-r-s3' : 'vf-s3'} />
        </linearGradient>
      </defs>
      <path d="M60 4l50 20v40c0 34-22 60-50 72C32 124 10 98 10 64V24z" fill={`url(#${id})`} />
      <path
        d="M60 14l41 16.4V64c0 28-17.6 49-41 59-23.4-10-41-31-41-59V30.4z"
        fill="rgba(5,9,18,.55)"
        stroke="rgba(255,255,255,.35)"
      />
      {bad ? (
        <path className="vf-mark" d="M44 52l32 32M76 52L44 84" fill="none" stroke="white" strokeWidth="9" strokeLinecap="round" />
      ) : (
        <path
          className={id === 'vf-hero-g' ? 'vf-tick' : 'vf-mark'}
          d="M38 66l15 15 30-33"
          fill="none"
          stroke="white"
          strokeWidth="9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function VerifyBarcodeView({ storeId, initialCode }: { storeId: string; initialCode?: string }) {
  // Opened from a printed QR (`?code=…`): the page starts on the radar, so there is no flash of the hero first.
  const [phase, setPhase] = useState<Phase>(initialCode ? { at: 'checking' } : { at: 'start' });
  const started = useRef(false);

  const check = useCallback(
    async (code: string) => {
      setPhase({ at: 'checking' });
      try {
        const [data] = await Promise.all([
          apiJson<{ genuine?: boolean }>(`/api/public/verify-barcode/${storeId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          }),
          wait(CHECK_MS),
        ]);
        setPhase({ at: 'verdict', genuine: Boolean(data.genuine) });
      } catch {
        setPhase({ at: 'start', failed: true });
      }
    },
    [storeId]
  );

  // The sheet waits for this before it closes; the check runs on behind it, so the camera goes away at once.
  const onScan = useCallback(
    (code: string) => {
      void check(code);
      return 'جاري التحقق…';
    },
    [check]
  );

  // The code the QR carried is checked once, on arrival — the ref keeps a second effect run from checking it twice.
  useEffect(() => {
    if (!initialCode || started.current) return;
    started.current = true;
    void check(initialCode);
  }, [initialCode, check]);

  const retry = () => {
    // «تحقق من منتج آخر» starts clean: the code that came in the link is dropped, so a reload does not repeat it.
    if (initialCode) window.history.replaceState(null, '', window.location.pathname);
    setPhase({ at: 'start' });
  };

  if (phase.at === 'checking') return <Checking />;
  if (phase.at === 'verdict') return <Verdict genuine={phase.genuine} onRetry={retry} />;

  return (
    <main className="vf">
      <header className="vf-hero">
        <div className="vf-gridbg" />
        <div className="vf-blob vf-b1" />
        <div className="vf-blob vf-b2" />
        <div className="vf-dots" aria-hidden>
          {DOTS.map(([l, t, s, d, k], i) => (
            <i key={i} style={{ ['--l' as string]: `${l}%`, ['--t' as string]: `${t}%`, ['--s' as string]: `${s}px`, ['--d' as string]: `${d}s`, ['--k' as string]: `${k}s` }} />
          ))}
        </div>
        <div className="vf-wrap">
          <div>
            <div className="vf-chip">
              <b /> نظامك الذكي للتأكد من أصالة المنتج
            </div>
            <h1>
              {['تأكد', 'أن', 'منتجك'].map((w, i) => (
                <span key={w}>
                  <span className="vf-w" style={{ ['--d' as string]: i }}>{w}</span>{' '}
                </span>
              ))}
              {/* The gradient sits on an inner span: on the same element its own animation would replace the word's fade-in. */}
              <span className="vf-w" style={{ ['--d' as string]: 3 }}><span className="vf-grad">أصلي</span></span>{' '}
              <span className="vf-w" style={{ ['--d' as string]: 4 }} dir="ltr"><span className="vf-grad">100%</span></span>
            </h1>
            <p className="vf-lead">
              اضغط «تحقق الآن» ووجّه الكاميرا نحو الباركود الموجود على المنتج — تعرف خلال ثوانٍ إن كان ما بين يديك أصلياً.
            </p>
            <div className="vf-cta">
              <span className="vf-vwrap">
                <ScanButton onScan={onScan} title="امسح الباركود على المنتج" label="تحقق الآن" continuous={false} className="vf-btn" />
              </span>
              <a href="#how" className="vf-ghost">كيف يعمل؟</a>
            </div>
            {phase.failed && <p className="vf-err">تعذّر التحقق الآن — تأكد من الاتصال وحاول مرة أخرى.</p>}
            <div className="vf-trust">
              <span><Check /> فحص في ثوانٍ</span>
              <span><Check /> آمن وخاص</span>
              <span><Check /> متاح دائماً</span>
            </div>
          </div>
          <div className="vf-stage" aria-hidden>
            <div className="vf-halo" />
            <div className="vf-ring vf-r1" />
            <div className="vf-ring vf-r2" />
            <div className="vf-ring vf-r3" />
            <svg className="vf-orbit" viewBox="0 0 100 100">
              <defs>
                <path id="vf-orbit-c" d="M50,50 m-43,0 a43,43 0 1,1 86,0 a43,43 0 1,1 -86,0" />
              </defs>
              <text>
                <textPath href="#vf-orbit-c">ORIGINAL • GENUINE • AUTHENTIC • ORIGINAL • GENUINE • AUTHENTIC •</textPath>
              </text>
            </svg>
            <span className="vf-shield">
              <ShieldArt id="vf-hero-g" />
            </span>
          </div>
        </div>
      </header>

      <section id="how" className="vf-sec">
        <div className="vf-wrap">
          <h2>
            كيف <span className="vf-grad">يعمل</span>؟
          </h2>
          <p className="vf-sub">ثلاث خطوات، ولا تحتاج تسجيل دخول ولا تطبيق.</p>
          <div className="vf-steps">
            <div className="vf-step">
              <div className="vf-num">1</div>
              <h3>اضغط «تحقق الآن»</h3>
              <p>واسمح للصفحة باستخدام الكاميرا.</p>
            </div>
            <div className="vf-step">
              <div className="vf-num">2</div>
              <h3>صوّر الباركود</h3>
              <p>وجّه الكاميرا نحو الرمز على العلبة أو الملصق.</p>
            </div>
            <div className="vf-step">
              <div className="vf-num">3</div>
              <h3>النتيجة فوراً</h3>
              <p>«أصلي» أو «غير أصلي» — خلال ثوانٍ.</p>
            </div>
          </div>
        </div>
      </section>

      <footer className="vf-foot">جميع الحقوق محفوظة</footer>
    </main>
  );
}

function Checking() {
  return (
    <main className="vf">
      <div className="vf-ov" role="status" aria-live="polite">
        <div className="vf-ovgrid" />
        <div className="vf-ph">
          <div className="vf-radar" aria-hidden>
            <i />
            <i />
            <i />
          </div>
          <p className="vf-scanning">جاري التحقق من المنتج…</p>
          <div className="vf-bar">
            <b />
          </div>
        </div>
      </div>
    </main>
  );
}

function Verdict({ genuine, onRetry }: { genuine: boolean; onRetry: () => void }) {
  const ring = genuine
    ? 'ORIGINAL • GENUINE • AUTHENTIC • ORIGINAL • GENUINE • AUTHENTIC •'
    : 'NOT VERIFIED • NOT VERIFIED • NOT VERIFIED • NOT VERIFIED •';
  return (
    <main className="vf">
      <div className={`vf-ov ${genuine ? '' : 'vf-bad'}`} role="status" aria-live="polite">
        <div className="vf-ovgrid" />
        <div className="vf-ph">
          <div className="vf-seal" aria-hidden>
            <span className="vf-rip" />
            <span className="vf-rip" />
            <span className="vf-rip" />
            <svg className="vf-sealtxt" viewBox="0 0 100 100">
              <defs>
                <path id="vf-seal-c" d="M50,50 m-42,0 a42,42 0 1,1 84,0 a42,42 0 1,1 -84,0" />
              </defs>
              <text>
                <textPath href="#vf-seal-c">{ring}</textPath>
              </text>
            </svg>
            <span className="vf-sh">
              <ShieldArt bad={!genuine} id={genuine ? 'vf-ok-g' : 'vf-bad-g'} />
            </span>
          </div>
          <h2 className="vf-verdict">
            {genuine ? <span className="vf-grad">المنتج أصلي</span> : <span className="vf-red">غير أصلي</span>}
          </h2>
          <p className="vf-why">
            {genuine
              ? 'هذا الرمز مسجّل في قائمة المنتجات الأصلية لهذا المتجر. اشترِ وأنت مطمئن.'
              : 'هذا الرمز غير مسجّل لدينا. قد يكون المنتج غير أصلي، أو قُرئ الرمز بشكل خاطئ — أعد المحاولة، وإن تكررت النتيجة تواصل مع المتجر.'}
          </p>
          <div className="vf-meta">
            {genuine ? (
              <>
                <span>تم التحقق</span>
                <span>مسجّل لدى المتجر</span>
              </>
            ) : (
              <span>لم يتم التحقق</span>
            )}
          </div>
          <div className="vf-acts">
            <Button onClick={onRetry} className="vf-btn">
              تحقق من منتج آخر
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
