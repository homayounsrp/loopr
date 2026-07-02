import type { ReactNode } from "react";

export const metadata = {
  title: "Loopr",
  description: "Watch a maker→checker loop iterate an artifact until it clears your rubric.",
};

// Global design system: tokens, fonts, keyframes, base resets, and the few things
// inline styles can't express (:hover, ::selection, scrollbars, @keyframes).
const GLOBAL_CSS = `
/* shared (theme-independent) tokens */
:root{
  --r-sm:9px; --r:13px; --r-lg:16px; --r-pill:999px;
  --ease:cubic-bezier(.22,.7,.2,1);
}

/* ── dark theme (default) ─────────────────────────────────────────── */
:root, :root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0a0b10;
  --surface:#14161e;
  --surface-2:#0f1119;
  --surface-3:#1c1f2a;
  --border:#242834;
  --border-2:#2f3441;
  --text:#e9ebf2;
  --text-2:#969db0;
  --text-3:#646b7c;
  --accent:#7b6bff;
  --accent-ink:#b7adff;
  --accent-weak:rgba(123,107,255,.16);
  --cyan:#43c6f0;
  --cyan-weak:rgba(67,198,240,.15);
  --good:#3ddc91; --good-weak:rgba(61,220,145,.15); --good-ink:#6ee7a8;
  --warn:#f3bf4d; --warn-weak:rgba(243,191,77,.15); --warn-ink:#f8d27e;
  --bad:#f6716f; --bad-weak:rgba(246,113,111,.15); --bad-ink:#fca5a4;
  --blue:#7ea6ff; --blue-weak:rgba(96,140,255,.16);
  --sheen:linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,0) 46%);
  --scroll:#2c313d; --scroll-h:#3a4150;
  --sel:rgba(123,107,255,.4);
  --sh-sm:0 1px 2px rgba(0,0,0,.35);
  --sh:0 16px 40px -16px rgba(0,0,0,.66), 0 2px 8px -3px rgba(0,0,0,.5);
  --sh-lg:0 40px 80px -30px rgba(0,0,0,.7);
  --page:
    radial-gradient(900px 460px at 14% -12%, rgba(123,107,255,.18) 0%, rgba(123,107,255,0) 60%),
    radial-gradient(820px 420px at 102% -8%, rgba(67,198,240,.12) 0%, rgba(67,198,240,0) 56%),
    var(--bg);
}

/* ── light theme ──────────────────────────────────────────────────── */
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#eef0f5;
  --surface:#ffffff;
  --surface-2:#f5f6fa;
  --surface-3:#ebedf3;
  --border:#e4e7ee;
  --border-2:#d6dae4;
  --text:#141620;
  --text-2:#59606f;
  --text-3:#8a91a1;
  --accent:#5b53f0;
  --accent-ink:#4038c9;
  --accent-weak:rgba(91,83,240,.1);
  --cyan:#0e93cc;
  --cyan-weak:rgba(14,147,204,.1);
  --good:#12924a; --good-weak:rgba(18,146,74,.12); --good-ink:#0d7a3c;
  --warn:#c26a06; --warn-weak:rgba(194,106,6,.12); --warn-ink:#95530a;
  --bad:#d83a3f; --bad-weak:rgba(216,58,63,.1); --bad-ink:#b02a2f;
  --blue:#2563eb; --blue-weak:rgba(37,99,235,.1);
  --sheen:none;
  --scroll:#c9cdd8; --scroll-h:#b3b8c6;
  --sel:rgba(91,83,240,.22);
  --sh-sm:0 1px 2px rgba(16,18,28,.06);
  --sh:0 14px 34px -16px rgba(24,22,55,.18), 0 2px 8px -3px rgba(24,22,55,.07);
  --sh-lg:0 30px 64px -24px rgba(30,22,70,.22);
  --page:
    radial-gradient(900px 460px at 14% -12%, rgba(91,83,240,.10) 0%, rgba(91,83,240,0) 60%),
    radial-gradient(820px 420px at 102% -8%, rgba(14,147,204,.08) 0%, rgba(14,147,204,0) 56%),
    var(--bg);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  min-height:100vh;
  background:var(--page);
  background-attachment:fixed;
  color:var(--text);
  font-family:'Inter','SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  font-feature-settings:'cv02','cv03','cv04','ss01';
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
  transition:background-color .3s var(--ease), color .3s var(--ease);
}
::selection{background:var(--sel);color:var(--text)}
a{color:inherit}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--scroll);border-radius:99px;border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:var(--scroll-h);background-clip:content-box}
input[type=range]{accent-color:var(--accent)}
input[type=checkbox]{accent-color:var(--accent);width:15px;height:15px}

@keyframes dl-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes dl-fade{from{opacity:0}to{opacity:1}}
@keyframes dl-slide{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}
@keyframes dl-pop{0%{opacity:0;transform:scale(.9)}60%{transform:scale(1.03)}100%{opacity:1;transform:scale(1)}}
@keyframes dl-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.8)}}
@keyframes dl-spin{to{transform:rotate(360deg)}}
@keyframes dl-draw{to{stroke-dashoffset:0}}
@keyframes dl-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes dl-shimmer{100%{background-position:200% 0}}
@keyframes dl-ping{0%{transform:scale(1);opacity:.55}70%,100%{transform:scale(2.6);opacity:0}}
@keyframes dl-breathe{0%,100%{opacity:1}50%{opacity:.55}}

.dl-rise{animation:dl-rise .55s var(--ease) both}
.dl-fade{animation:dl-fade .5s var(--ease) both}
.dl-slide{animation:dl-slide .4s var(--ease) both}
.dl-pop{animation:dl-pop .35s var(--ease) both}

.dl-card{transition:box-shadow .28s var(--ease),transform .28s var(--ease),border-color .28s var(--ease),background-color .3s var(--ease)}
.dl-card:hover{box-shadow:var(--sh);transform:translateY(-2px);border-color:var(--border-2)}

.dl-btn{transition:transform .12s var(--ease),box-shadow .2s var(--ease),background .18s,opacity .18s,filter .18s;cursor:pointer;user-select:none}
.dl-btn:hover{transform:translateY(-1px);filter:brightness(1.04)}
.dl-btn:active{transform:translateY(0) scale(.97)}
.dl-btn:disabled{opacity:.45;cursor:not-allowed;transform:none;filter:none}

.dl-row{transition:background .16s var(--ease),transform .16s var(--ease)}
.dl-row:hover{background:var(--surface-3)}

.dl-input{transition:border-color .18s,box-shadow .18s,background .18s}
.dl-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak)}
.dl-input::placeholder{color:var(--text-3)}

.dl-link{transition:color .15s}
.dl-link:hover{color:var(--accent-ink)}

.dl-chev{transition:transform .25s var(--ease)}
.dl-open .dl-chev{transform:rotate(180deg)}

.dl-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:dl-draw 1s var(--ease) .1s forwards}
.dl-bar{transform-origin:left;animation:dl-grow .6s var(--ease) both}
.dl-num{font-variant-numeric:tabular-nums;font-feature-settings:'tnum','cv02'}

/* responsive: below 1080 the artifact rail stacks under the main column */
@media (max-width:1080px){
  .dl-cols{flex-direction:column}
  .dl-rail{width:100% !important;position:static !important;max-height:none !important;height:auto !important;order:0 !important;top:auto !important}
  .dl-rail iframe{height:70vh !important}
}
@media (max-width:640px){
  .dl-hide-sm{display:none !important}
}
`;

// Set the theme before first paint (no flash of the wrong theme).
const THEME_INIT = `
(function(){try{
  var t=localStorage.getItem('loopr-theme');
  if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
  document.documentElement.setAttribute('data-theme',t);
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
