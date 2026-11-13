export const themeControl = `
const themes = ['system', 'light', 'dark'];
let theme = 'system';
try {
  const saved = localStorage.getItem('maple-theme');
  if (themes.includes(saved)) theme = saved;
} catch {}
document.documentElement.dataset.theme = theme;
document.addEventListener('DOMContentLoaded', () => {
  const picker = document.getElementById('site-theme');
  picker.value = theme;
  picker.addEventListener('change', () => {
    document.documentElement.dataset.theme = picker.value;
    try { localStorage.setItem('maple-theme', picker.value); } catch {}
  });
});
`;

export const siteAppearance = `
:root{color-scheme:light dark;--page:light-dark(#f5f6fa,#0e1016);--panel:light-dark(#fff,#171a24);
  --control:light-dark(#fff,#232737);--line:light-dark(#d4d9e5,#3a4053);--ink:light-dark(#202537,#f6f4fb);
  --subtle:light-dark(#525e76,#b9c2d6);--link:light-dark(#383986,#ccc3ff);--brand:light-dark(#91420e,#ffb46f);
  --selected:light-dark(#e8e8f8,#30354b);--empty:light-dark(#edf0f5,#11141d);
  --focus:light-dark(#4545ab,#c5b9ff)}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark}
body{background:var(--page);color:var(--ink);font-size:16px}
main{max-width:72rem;padding:1.25rem clamp(.75rem,3vw,2rem) 2.5rem}
a{color:var(--link)}
:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
article,details,.official-button,.search-home-link{background:var(--panel);border-color:var(--line)}
.image-preview{background:transparent}
input,button,select,textarea{background:var(--control);color:var(--ink);border:1px solid var(--line);border-radius:.45rem;font:inherit}
select,textarea{padding:.35rem .55rem}
.site-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem 1rem;
  padding:.65rem max(.75rem,calc((100% - 72rem)/2));background:var(--panel);border-bottom:1px solid var(--line)}
.site-header>a{color:var(--brand);font-weight:750;text-decoration:none}
.site-header label{color:var(--subtle);font-size:.9rem}
.site-tabs,.activity-nav{border-color:var(--line)}
.site-tabs a[aria-current=page]{background:var(--selected);color:var(--ink)}
.activity-nav{background:var(--page)}
.event-label{border-color:var(--line);color:var(--subtle)}
.source-table td,.source-table th{border-color:var(--line)}
.source-table th,.source-table tr:first-child{background:var(--selected)}
.source-panel article:target{border-color:var(--focus);outline-color:var(--focus)}
.home-title{text-align:center;margin:1.5rem 0 .8rem}
.home-search form{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:.55rem}
.home-search input[type=text],.home-search input[name=q]{width:min(100%,24rem);box-sizing:border-box}
.home-grid{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
.home-grid details{margin:.55rem 0 0;padding:.45rem .6rem}
.home-grid ul{margin:.5rem 0;padding-inline-start:1.4rem}
.home-deadlines{margin:1.4rem 0;padding:.75rem 1rem;background:var(--panel);border:1px solid var(--line);border-radius:.65rem}
.home-deadlines h2{margin:.15rem 0 .5rem;font-size:1.15rem}
.home-deadlines ul{list-style:none;padding:0;margin:0}
.home-deadlines>ul>li{padding:.3rem 0}
.home-deadlines>ul>li+li{border-top:1px solid var(--line)}
.deadline-row{display:flex;justify-content:space-between;flex-wrap:wrap;gap:.2rem 1rem}
.home-deadlines details{margin:.25rem 0;padding:.25rem .6rem}
.home-deadlines details ul{list-style:disc;padding-inline-start:1.4rem}
.home-deadlines time{color:var(--brand);font-variant-numeric:tabular-nums}
.special-time-notes{color:var(--subtle);font-size:.9rem}
.special-time-notes p{margin:.2rem 0 .4rem}
@media(max-width:560px){.home-grid{grid-template-columns:minmax(0,1fr)}}
.activity-family,.activity-grid>article{border-top-color:var(--stripe,#6f75a4)}
.activity-family>h2{color:var(--ink)}
[data-tone="0"]{--stripe:light-dark(#318064,#70e0b5)}
[data-tone="1"]{--stripe:light-dark(#4a65ac,#9cb5ff)}
[data-tone="2"]{--stripe:light-dark(#a55a23,#ffc28a)}
[data-tone="3"]{--stripe:light-dark(#855292,#e2a9ee)}
[data-tone="4"]{--stripe:light-dark(#287384,#85d9ec)}
.calendar-grid,.calendar-details,.calendar-cell{border-color:var(--line);background:var(--panel)}
.calendar-cell-empty{background:var(--empty)}
.calendar-weekday,.calendar-cell-selected{background:var(--selected)}
.calendar-band{box-sizing:border-box;color:var(--ink);border:1px solid var(--stripe);
  border-inline-start:4px solid var(--stripe);background:color-mix(in srgb,var(--stripe) 15%,var(--panel))}
.calendar-count{background:var(--selected);color:var(--ink)}
.calendar-count-end{background:light-dark(#fae9d8,#442b1e);color:light-dark(#68370e,#ffcd9d)}
.calendar-today::after{border-color:var(--focus)}
.calendar-today-label{background:var(--focus);color:light-dark(#fff,#171a24)}
`;
