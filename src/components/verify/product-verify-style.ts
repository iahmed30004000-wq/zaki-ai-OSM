/**
 * THE LOOK OF A PRODUCT'S OWN PAGE (`/v/<slug>`), AND OF ITS PREVIEW IN THE OWNER'S EDITOR.
 *
 * One string, drawn by `ProductVerifyView` itself in a `<style>`, so the public page and the live preview inside the
 * dashboard wear exactly the same rules. Every rule sits under `.vp` — nothing here can reach the dashboard around the
 * preview. The owner's colours arrive as custom properties on the root (`--vp-p`, `--vp-bg`, …), set from validated
 * `#rrggbb` values only.
 *
 * Not an imported `.css`: that would be a chunk of its own counted by the first-load stylesheet budget for every
 * visitor of every page. And this FILE is excluded from Tailwind's scan (`@source not` in `globals.css`), so no word in
 * the rules below can grow the shared utility sheet.
 */
export const PRODUCT_VERIFY_CSS = `
.vp{--vp-card:#ffffff;--vp-line:rgba(15,23,42,.09);--vp-red:#d14343;--vp-red-soft:#fdf1f1;
  position:relative;min-height:100vh;background:var(--vp-bg);color:var(--vp-ink);direction:rtl;
  font-family:'Cairo',Tahoma,'Segoe UI',system-ui,sans-serif;line-height:1.7;padding:0 0 40px;overflow:hidden}
.vp.vp-dark{--vp-card:rgba(255,255,255,.06);--vp-line:rgba(255,255,255,.12);--vp-red:#ff7b7b;--vp-red-soft:rgba(255,93,108,.12)}
.vp *{box-sizing:border-box}
.vp.vp-pv{min-height:0;border-radius:18px}
.vp-glow{position:absolute;inset:-30% -20% auto;height:520px;background:radial-gradient(closest-side,var(--vp-p),transparent);opacity:.16;pointer-events:none}
.vp-wrap{position:relative;width:min(560px,100% - 28px);margin-inline:auto}
.vp-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 0 6px}
.vp-logo{height:40px;max-width:150px;object-fit:contain}
.vp-mono{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-weight:900;background:var(--vp-p);color:var(--vp-on-p)}
.vp-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:700;color:var(--vp-p);background:var(--vp-card);border:1px solid var(--vp-line)}
.vp-chip svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.vp-hero{text-align:center;padding:10px 0 4px}
.vp-media{width:min(280px,72vw);aspect-ratio:1;margin:8px auto 18px;border-radius:28px;background:var(--vp-card);border:1px solid var(--vp-line);display:grid;place-items:center;overflow:hidden;box-shadow:0 24px 60px -28px rgba(15,23,42,.35)}
.vp-media img{width:100%;height:100%;object-fit:cover}
.vp h1,.vp h2,.vp h3{margin:0;line-height:1.3;font-weight:900}
.vp-hero h1{font-size:clamp(24px,6.4vw,32px)}
.vp-head{margin:6px auto 0;max-width:460px;color:var(--vp-mute);font-size:16px}
.vp-card{background:var(--vp-card);border:1px solid var(--vp-line);border-radius:22px;padding:20px;margin-top:18px;box-shadow:0 18px 50px -34px rgba(15,23,42,.4)}
.vp-card h2{font-size:19px;margin-bottom:4px}
.vp-card p{margin:0}
.vp-sub{color:var(--vp-mute);font-size:14px}
.vp-form{display:flex;gap:8px;margin-top:14px}
.vp-in{flex:1;min-width:0;height:52px;border-radius:14px;border:1.5px solid var(--vp-line);background:transparent;color:inherit;padding:0 14px;font:600 16px 'Cairo',Tahoma,sans-serif;direction:ltr;text-align:left}
.vp-in:focus{outline:none;border-color:var(--vp-p);box-shadow:0 0 0 4px color-mix(in srgb,var(--vp-p) 20%,transparent)}
.vp .vp-go{height:52px;padding:0 22px;border:0;border-radius:14px;background:var(--vp-p);color:var(--vp-on-p);font:800 16px 'Cairo',Tahoma,sans-serif;cursor:pointer;white-space:nowrap}
.vp .vp-go:disabled{opacity:.6;cursor:default}
.vp .vp-cam{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:50px;margin-top:10px;border-radius:14px;border:1.5px dashed color-mix(in srgb,var(--vp-p) 55%,transparent);background:color-mix(in srgb,var(--vp-p) 7%,transparent);color:var(--vp-p);font:800 15px 'Cairo',Tahoma,sans-serif;cursor:pointer}
.vp .vp-cam svg{width:20px;height:20px;fill:currentColor}
.vp-err{margin-top:10px;color:var(--vp-red);font-weight:700;font-size:14px}
.vp-verdict{margin-top:18px;border-radius:22px;padding:24px 20px;text-align:center;animation:vp-in .45s cubic-bezier(.2,1,.3,1) both}
.vp-ok{background:var(--vp-p);color:var(--vp-on-p);box-shadow:0 24px 60px -24px var(--vp-p)}
.vp-bad{background:var(--vp-red-soft);color:var(--vp-red);border:1.5px solid color-mix(in srgb,var(--vp-red) 35%,transparent)}
.vp-seal{width:76px;height:76px;margin:0 auto 10px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.2)}
.vp-bad .vp-seal{background:color-mix(in srgb,var(--vp-red) 14%,transparent)}
.vp-seal svg{width:40px;height:40px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.vp-seal path{stroke-dasharray:60;stroke-dashoffset:60;animation:vp-draw .6s .25s forwards}
.vp-verdict h3{font-size:clamp(24px,7vw,30px);margin-bottom:6px}
.vp-verdict p{margin:0 auto;max-width:420px;font-size:15px;opacity:.95}
.vp .vp-again{margin-top:14px;height:42px;padding:0 18px;border-radius:12px;border:1.5px solid currentColor;background:transparent;color:inherit;font:700 14px 'Cairo',Tahoma,sans-serif;cursor:pointer}
.vp-checking{margin-top:18px;display:flex;align-items:center;justify-content:center;gap:12px;padding:22px;border-radius:22px;border:1px dashed var(--vp-line);color:var(--vp-mute);font-weight:700}
.vp-spin{width:22px;height:22px;border-radius:50%;border:3px solid color-mix(in srgb,var(--vp-p) 25%,transparent);border-top-color:var(--vp-p);animation:vp-turn .8s linear infinite}
.vp-desc{white-space:pre-line;color:var(--vp-ink);font-size:15px}
.vp-feats{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:10px}
.vp-feats li{display:flex;gap:10px;align-items:flex-start;font-size:15px;font-weight:600}
.vp-feats i{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--vp-p) 15%,transparent);color:var(--vp-p)}
.vp-feats svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.vp-acts{display:grid;gap:10px;margin-top:18px}
.vp .vp-btn{display:flex;align-items:center;justify-content:center;gap:10px;height:54px;border-radius:16px;font:800 16px 'Cairo',Tahoma,sans-serif;text-decoration:none;cursor:pointer;border:0}
.vp .vp-btn svg{width:22px;height:22px}
.vp .vp-wa{background:#1fa855;color:#fff}
.vp .vp-wa svg{fill:currentColor}
.vp .vp-re{background:var(--vp-card);color:var(--vp-ink);border:1.5px solid var(--vp-line)}
.vp .vp-re svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.vp-foot{margin-top:26px;text-align:center;color:var(--vp-mute);font-size:12px}
@keyframes vp-in{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
@keyframes vp-draw{to{stroke-dashoffset:0}}
@keyframes vp-turn{to{transform:rotate(360deg)}}
@media(min-width:720px){.vp-wrap{width:min(600px,100% - 48px)}.vp-top{padding-top:28px}}
@media(prefers-reduced-motion:reduce){.vp *,.vp *::before,.vp *::after{animation-duration:.01ms!important;animation-delay:0s!important;animation-iteration-count:1!important}}
`;
