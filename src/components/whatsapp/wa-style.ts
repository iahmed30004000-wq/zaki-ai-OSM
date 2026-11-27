/**
 * THE INBOX'S WHATSAPP LOOK (the owner, 2026-11-26: «يكون مشابه للواتساب جدا»), and the bot's practice chat.
 *
 * One string, drawn in a `<style>` by the inbox and by the practice chat only (`WaStyle`), every rule under `.wa` — nothing
 * here reaches another screen, and nothing is in the stylesheet every page loads. This FILE is excluded from Tailwind's scan
 * (`@source not` in `globals.css`), so no word below can grow the shared utility sheet (`quality-gates.test.ts`).
 *
 * Every colour is a custom property declared on `.wa` with `light-dark()`: the palettes declare their `color-scheme`, so the
 * light and dark looks follow the theme the person chose, with no colour in a component (`system-themes.test.ts`). They are
 * WhatsApp's own colours — the wallpaper, the green of our bubbles, the white of theirs, the blue of a read tick — a brand's
 * look, like the WhatsApp green the colour guard already allows by name.
 *
 * Unlayered on purpose: the kit's buttons carry utility classes, which live in a cascade layer, so a rule here wins over
 * them without `!important` where the look needs it (the round green send button, the icons inside the pill).
 */
const DOODLE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180' viewBox='0 0 180 180' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M18 26c0-6 5-10 11-10h16c6 0 11 4 11 10v7c0 6-5 10-11 10H33l-9 7v-7c-4-2-6-5-6-9z'/%3E%3Ccircle cx='132' cy='28' r='8'/%3E%3Cpath d='M98 74l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z'/%3E%3Cpath d='M30 120c-5-7 5-14 10-7 5-7 15 0 10 7l-10 10z'/%3E%3Cpath d='M128 128h26M141 115v26'/%3E%3Cpath d='M52 72q9-9 18 0t18 0'/%3E%3Crect x='146' y='70' width='20' height='14' rx='4'/%3E%3Cpath d='M76 160l9-9 9 9'/%3E%3Cpath d='M8 166h18'/%3E%3Ccircle cx='96' cy='126' r='3'/%3E%3Cpath d='M160 160a10 10 0 1 1-10-10'/%3E%3C/svg%3E";

export const WA_CSS = `
.wa{--wa-wall:light-dark(#efeae2,#0b141a);--wa-doodle:light-dark(#c9bfae,#2a3942);--wa-in:light-dark(#ffffff,#202c33);
  --wa-out:light-dark(#d9fdd3,#005c4b);--wa-ink:light-dark(#111b21,#e9edef);--wa-meta:light-dark(#667781,#8696a0);
  --wa-tick:#53bdeb;--wa-green:light-dark(#008069,#00a884);--wa-send:#00a884;--wa-on-send:#ffffff;
  --wa-badge:light-dark(#25d366,#00a884);--wa-on-badge:light-dark(#ffffff,#111b21);--wa-bar:light-dark(#f0f2f5,#202c33);
  --wa-panel:light-dark(#ffffff,#111b21);--wa-line:light-dark(#e9edef,#222d34);--wa-hover:light-dark(#f5f6f6,#202c33);
  --wa-active:light-dark(#f0f2f5,#2a3942);--wa-chip:light-dark(#ffffff,#182229);--wa-input:light-dark(#ffffff,#2a3942);
  --wa-bot:light-dark(#6d28d9,#c4b5fd);--wa-bot-soft:light-dark(#ede9fe,#2e1065);--wa-shadow:light-dark(#0b141a21,#00000059);
  --wa-note:light-dark(#fff5c4,#3a3520);--wa-note-ink:light-dark(#54656f,#e9edef);--wa-warn:light-dark(#b45309,#fbbf24);
  --wa-av:light-dark(#dfe5e7,#2a3942);--wa-av-ink:light-dark(#54656f,#d1d7db);--wa-bot-av:light-dark(#00a884,#00a884);
  color:var(--wa-ink)}
.wa *{box-sizing:border-box}

/* ── the list ── */
.wa-list{background:var(--wa-panel)}
.wa-search{background:var(--wa-bar);border:0;border-radius:8px;color:var(--wa-ink)}
.wa-search::placeholder{color:var(--wa-meta)}
.wa-row{display:flex;align-items:center;gap:12px;width:100%;padding:0 12px;text-align:right;background:transparent;border:0;cursor:pointer;color:inherit}
.wa-row:hover{background:var(--wa-hover)}
.wa-row[aria-current="true"]{background:var(--wa-active)}
.wa-row:focus-visible{outline:2px solid var(--wa-green);outline-offset:-2px}
.wa-row-body{flex:1;min-width:0;padding:12px 0;border-bottom:1px solid var(--wa-line)}
.wa-row-top,.wa-row-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wa-name{font-size:16px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--wa-ink)}
.wa-time{flex:none;font-size:12px;color:var(--wa-meta);font-variant-numeric:tabular-nums}
.wa-time.unread{color:var(--wa-badge);font-weight:600}
.wa-prev{display:flex;align-items:center;gap:4px;min-width:0;font-size:14px;color:var(--wa-meta)}
.wa-prev span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-prev.typing{color:var(--wa-green);font-weight:500}
.wa-unread{flex:none;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--wa-badge);color:var(--wa-on-badge);font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.wa-tags{display:flex;align-items:center;gap:4px;flex:none}
.wa-tag{display:inline-flex;align-items:center;gap:3px;height:20px;padding:0 7px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap}
.wa-tag.bot{background:var(--wa-bot-soft);color:var(--wa-bot)}
.wa-tag.hand{background:var(--wa-note);color:var(--wa-warn)}
.wa-sub{font-size:12px;color:var(--wa-meta);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}

/* ── avatars ── */
.wa-av{flex:none;width:49px;height:49px;border-radius:50%;background:var(--wa-av);color:var(--wa-av-ink);display:grid;place-items:center;font-weight:700;font-size:16px;position:relative}
.wa-av.sm{width:40px;height:40px;font-size:15px}
.wa-av.lg{width:80px;height:80px;font-size:26px}
.wa-av.bot{background:var(--wa-bot-av);color:var(--wa-on-send)}

/* ── the open conversation ── */
.wa-pane{flex-direction:column;min-height:0;background:var(--wa-wall)}
.wa-head{display:flex;align-items:center;gap:10px;padding:8px 14px;min-height:60px;background:var(--wa-bar);border-bottom:1px solid var(--wa-line);flex:none}
.wa-head-name{font-size:16px;font-weight:600;color:var(--wa-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-head-sub{font-size:13px;color:var(--wa-meta);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px}
.wa-head-sub .on{color:var(--wa-green);font-weight:600}
.wa-head-sub .off{color:var(--wa-warn);font-weight:600}
.wa-head-sub .bot{color:var(--wa-bot);font-weight:600;display:inline-flex;align-items:center;gap:3px}
.wa-wall{position:relative;flex:1;min-height:0;background:var(--wa-wall);isolation:isolate}
.wa-wall::before{content:"";position:absolute;inset:0;z-index:-1;background:var(--wa-doodle);opacity:.38;pointer-events:none;
  -webkit-mask:url("${DOODLE}") 0 0/180px 180px repeat;mask:url("${DOODLE}") 0 0/180px 180px repeat}
.wa-scroll{height:100%;overflow-y:auto;padding:12px 6% 14px;display:flex;flex-direction:column;gap:2px;overscroll-behavior:contain}
.wa-day{align-self:center;margin:8px 0 6px;background:var(--wa-chip);color:var(--wa-meta);font-size:12.5px;font-weight:500;padding:5px 12px;border-radius:8px;box-shadow:0 1px .5px var(--wa-shadow)}
.wa-msg{display:flex;align-items:flex-end;gap:4px}
.wa-msg.out{justify-content:flex-end}
.wa-msg.in{justify-content:flex-start}
.wa-msg.first{margin-top:8px}
.wa-holder{position:relative;max-width:min(78%,560px)}
.wa-holder.reacted{margin-bottom:14px}
.wa-b{position:relative;padding:6px 9px 8px;border-radius:8px;font-size:14.2px;line-height:1.45;color:var(--wa-ink);box-shadow:0 1px .5px var(--wa-shadow);overflow-wrap:anywhere}
.wa-b::after{content:"";display:block;clear:both}
.wa-b.in{background:var(--wa-in)}
.wa-b.out{background:var(--wa-out)}
.wa-b.bare{background:transparent;box-shadow:none;padding:2px}
.wa-b.in.tail{border-top-left-radius:0}
.wa-b.out.tail{border-top-right-radius:0}
.wa-b.tail::before{content:"";position:absolute;top:0;width:8px;height:13px}
.wa-b.in.tail::before{left:-8px;background:linear-gradient(to bottom left,var(--wa-in) 50%,transparent 50%)}
.wa-b.out.tail::before{right:-8px;background:linear-gradient(to bottom right,var(--wa-out) 50%,transparent 50%)}
.wa-b.bare::before{display:none}
.wa-b .wa-text{white-space:pre-wrap;margin:0}
.wa-b .wa-text.big{font-size:36px;line-height:1.2}
.wa-meta{float:right;display:inline-flex;align-items:center;gap:3px;margin:8px 0 -5px 12px;font-size:11px;line-height:1;color:var(--wa-meta);font-variant-numeric:tabular-nums;direction:ltr;position:relative;top:2px}
.wa-meta svg{width:16px;height:16px}
.wa-tick-read{color:var(--wa-tick)}
.wa-tick{color:var(--wa-meta)}
.wa-by{display:flex;align-items:center;gap:3px;font-size:12.5px;font-weight:700;color:var(--wa-bot);margin-bottom:2px;direction:rtl}
.wa-by svg{width:16px;height:16px}
.wa-quote{margin:0 0 5px;padding:5px 8px;border-radius:6px;border-inline-start:4px solid var(--wa-green);background:var(--wa-bar);font-size:12.5px}
.wa-quote b{display:block;color:var(--wa-green);font-weight:600}
.wa-quote span{display:block;color:var(--wa-meta);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-card{display:flex;align-items:center;gap:10px;padding:8px;border-radius:6px;background:var(--wa-bar);min-width:0;color:inherit;text-decoration:none}
.wa-card-ic{flex:none;width:40px;height:40px;border-radius:6px;display:grid;place-items:center;background:var(--wa-chip);color:var(--wa-green)}
.wa-card b{display:block;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-card small{display:block;font-size:12px;color:var(--wa-meta);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-media{display:block;border-radius:6px;overflow:hidden;margin:-3px -6px 4px}
.wa-media img,.wa-media video{display:block;max-height:300px;width:auto;max-width:100%;object-fit:cover}
.wa-reacts{position:absolute;bottom:-14px;display:flex;align-items:center;gap:2px;padding:2px 6px;border-radius:999px;background:var(--wa-chip);box-shadow:0 1px 2px var(--wa-shadow);font-size:14px;line-height:1.2}
.wa-reacts.out{right:8px}
.wa-reacts.in{left:8px}
.wa-react{opacity:0;transition:opacity .15s}
.wa-msg:hover .wa-react,.wa-react[data-open="true"],.wa-react:focus-within{opacity:1}
.wa-typing{align-self:flex-end;display:flex;flex-direction:column;gap:2px;margin-top:8px;padding:6px 12px 9px;border-radius:8px;border-top-right-radius:0;background:var(--wa-out);box-shadow:0 1px .5px var(--wa-shadow);position:relative}
.wa-typing::before{content:"";position:absolute;top:0;right:-8px;width:8px;height:13px;background:linear-gradient(to bottom right,var(--wa-out) 50%,transparent 50%)}
.wa-dots{display:flex;gap:4px;padding:4px 0 0}
.wa-dots i{width:7px;height:7px;border-radius:50%;background:var(--wa-meta);animation:wa-dot 1s infinite}
.wa-dots i:nth-child(2){animation-delay:.15s}.wa-dots i:nth-child(3){animation-delay:.3s}
@keyframes wa-dot{0%,60%,100%{opacity:.3}30%{opacity:1}}
.wa-jump{position:absolute;bottom:12px;right:14px}

/* ── notes inside the conversation ── */
.wa-note{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 14px;background:var(--wa-note);color:var(--wa-note-ink);font-size:13px;border-top:1px solid var(--wa-line)}
.wa-note p{flex:1;min-width:12rem;margin:0;line-height:1.5}
.wa-note svg{flex:none;color:var(--wa-warn)}

/* ── the reply box ── */
.wa-foot{flex:none;background:var(--wa-bar);padding:6px 10px 8px;border-top:1px solid var(--wa-line)}
.wa-compose{display:flex;align-items:flex-end;gap:8px}
.wa-pill{flex:1;min-width:0;display:flex;align-items:flex-end;gap:2px;background:var(--wa-input);border-radius:24px;padding:3px 6px;box-shadow:0 1px .5px var(--wa-shadow)}
.wa-pill textarea{flex:1;min-width:0;resize:none;border:0;outline:none;background:transparent;color:var(--wa-ink);font:inherit;font-size:15px;line-height:1.4;padding:9px 6px;max-height:128px}
.wa-pill textarea::placeholder{color:var(--wa-meta)}
.wa-pill .wa-ib{color:var(--wa-meta);background:transparent;border-radius:50%}
.wa-pill .wa-ib:hover{color:var(--wa-ink);background:var(--wa-hover)}
.wa-send{flex:none;width:46px;height:46px;min-width:46px;border-radius:50%;background:var(--wa-send);color:var(--wa-on-send);border:0;box-shadow:0 1px 2px var(--wa-shadow)}
.wa-send:hover{filter:brightness(1.06);background:var(--wa-send)}
.wa-send:disabled{opacity:.55}
.wa-attach{margin-bottom:6px;display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;background:var(--wa-input)}
.wa-err{margin-bottom:6px}

/* ── the bot's practice chat ── */
.wa-sandbox{border:1px solid var(--wa-line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;height:min(560px,70vh)}
.wa-trace{font-size:11.5px;color:var(--wa-meta);align-self:center;max-width:92%;text-align:center;background:var(--wa-chip);border-radius:8px;padding:3px 10px;margin:4px 0;direction:ltr;overflow-wrap:anywhere}
.wa-trace.bad{color:var(--wa-warn)}
@media (prefers-reduced-motion:reduce){.wa-dots i{animation:none}.wa-react{transition:none}}

/* ── a phone (the owner, 27/11: «حسّن واجهة واتساب الشات بنسخة الموبايل») ──
   The list takes the screen under a short header; an open conversation takes the WHOLE screen, over the app's bars, as
   WhatsApp does — under the kit's dialogs (z-50), so «⋮» and «محادثة جديدة» still open above it. */
.wa-mob{display:none}
@media (max-width:1023.98px){
  .wa-top p{display:none}
  .wa-desk{display:none}
  .wa-mob{display:inline-flex}
  .wa-list{border-radius:12px;overflow:visible}
  .wa-panes,.wa-rows{overflow:visible}
  .wa-panes{padding-inline:8px}
  .wa-pane.wa-full{position:fixed;inset:0;z-index:45;border-radius:0;border:0;height:100dvh;
    padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
  .wa-pane.wa-full .wa-head{min-height:56px;padding:6px 8px}
  .wa-scroll{padding:10px 3% 12px}
  .wa-holder{max-width:86%}
  .wa-foot{padding:6px 6px 8px}
  .wa-head-sub{font-size:12px}
}
/* A narrow desk (a laptop, a half window): three columns left the conversation a strip. The customer column steps aside and
   «⋮» brings it, as on a phone. */
@media (min-width:1024px) and (max-width:1279.98px){
  .wa-panes{grid-template-columns:300px 1fr}
  .wa-side{display:none}
  .wa-mob{display:inline-flex}
}
`;
