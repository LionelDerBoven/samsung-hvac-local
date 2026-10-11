// Samsung HVAC Local — lokale bedieningspagina (draait volledig op de ESP, geen internet nodig).
// Praat met de ESPHome web_server: live toestand via SSE (/events), commando's via POST.

// Entiteiten volgens het bridge-contract (CONTRACT.md): domein + vaste Engelse rolnaam.
// Met sub-devices is de echte id "domein/<unit>/<naam>"; die wordt bij ontvangst gekoppeld (zie fid()).
const CLIMATE = 'climate/Climate';
const E = {
  room: 'sensor/Room temperature', hum: 'sensor/Room humidity', out: 'sensor/Outdoor temperature',
  evaIn: 'sensor/EVA in temperature', evaOut: 'sensor/EVA out temperature', power: 'sensor/Power',
  energy: 'sensor/Energy', err: 'sensor/Error code',
  fPct: 'sensor/Filter usage', fH: 'sensor/Filter hours', fCap: 'sensor/Filter capacity',
  fWarn: 'binary_sensor/Filter alarm', fReset: 'button/Filter reset', reboot: 'button/Restart',
  clean: 'switch/Auto clean',
  wifi: 'sensor/WiFi signal', up: 'sensor/Uptime', ip: 'text_sensor/IP address', mac: 'text_sensor/MAC address',
};
const full = {};           // korte rol-id → volledige id (eerste unit wint bij multi-split)
let unitName = '';
const shortId = id => { const p = id.split('/'); return p.length > 2 ? p[0] + '/' + p[p.length - 1] : id; };
const fid = id => full[id] || id;

const MODES = [
  ['cool', 'Koelen', '❄'], ['dry', 'Drogen', '💧'], ['fan_only', 'Ventileren', '🌀'],
  ['auto', 'Auto', 'A'], ['heat', 'Verwarmen', '☀'],
];
const FANS = [['AUTO', 'Auto'], ['LOW', 'Laag'], ['MIDDLE', 'Midden'], ['HIGH', 'Hoog'], ['Turbo', 'Turbo']];
const PRESETS = [
  ['NONE', 'Geen'], ['WindFree', 'WindFree'], ['Quiet', 'Quiet'], ['Fast', 'Fast'],
  ['ECO', 'Eco'], ['SLEEP', 'Slaap'], ['LongReach', 'LongReach'],
];
const SWINGS = [['OFF', 'Uit'], ['VERTICAL', 'Verticaal'], ['HORIZONTAL', 'Horizontaal'], ['BOTH', 'Beide']];
const TMIN = 16, TMAX = 30;
const tstep = () => parseFloat(st[CLIMATE]?.step) || 1; // from the bridge (climate visual step)
const fmtT = v => (tstep() < 1 ? v.toFixed(1) : String(Math.round(v)));
const LOGO = `<svg class="logo" viewBox="0 0 168 40" role="img" aria-label="HVAC Local"><g fill="none" stroke="var(--blue)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(2,2) scale(.56)"><rect x="6" y="12" width="52" height="22" rx="6"/><path d="M13 27h38"/><path d="M20 40c-3 4 3 7 0 12M32 40c-3 4 3 7 0 12M44 40c-3 4 3 7 0 12"/></g><text x="44" y="28" font-size="22" font-weight="800" fill="currentColor">HVAC <tspan fill="var(--blue)" font-weight="600">Local</tspan></text></svg>`;

const st = {};            // entity-id → laatste toestand
let lastOnMode = 'cool';  // modus om naar terug te keren bij "aan"
let pendingTarget = null, targetTimer = null;
const LOGKEY = 'sac-log-v1', LOGKEEP = 300;
const logs = (() => { try { return JSON.parse(localStorage.getItem(LOGKEY)) || []; } catch (_) { return []; } })();
let saveT = null;
const saveLogs = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(LOGKEY, JSON.stringify(logs.slice(-LOGKEEP))); } catch (_) { } }, 1000); };
let logPaused = false, logLevel = 'ALL';

// ---------- stijl ----------
const css = `
:root{--bg:#f4f5f7;--card:#fff;--ink:#111;--mut:#6b7280;--line:#e5e7eb;--blue:#0b63c5;--blue2:#2f80e0;
--ok:#0f9d58;--warn:#f59e0b;--bad:#dc2626;--chip:#eef1fb;--shadow:0 1px 2px rgba(0,0,0,.04),0 6px 24px rgba(11,99,197,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#151821;--ink:#f3f4f6;--mut:#9ca3af;--line:#262b38;
--blue:#5aa2f0;--blue2:#7cb6f4;--chip:#1c2233;--shadow:none}}
*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
body{background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:1080px;margin:auto;display:flex;align-items:center;gap:16px;padding:12px 16px;flex-wrap:wrap}
.logo{height:28px;width:auto;display:block;color:var(--ink)}
.sub{color:var(--mut);font-size:13px;border-left:1px solid var(--line);padding-left:14px}
nav{margin-left:auto;display:flex;gap:4px;background:var(--chip);padding:4px;border-radius:999px}
nav a{padding:7px 16px;border-radius:999px;color:var(--mut);text-decoration:none;font-weight:600;font-size:14px}
nav a.on{background:var(--card);color:var(--blue);box-shadow:var(--shadow)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--bad);display:inline-block;margin-right:6px}
.dot.ok{background:var(--ok)}
.conn{font-size:12px;color:var(--mut);display:flex;align-items:center}
main{max-width:1080px;margin:auto;padding:20px 16px 48px;display:grid;gap:16px;grid-template-columns:repeat(12,1fr)}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:var(--shadow);grid-column:span 12}
@media(min-width:860px){.s6{grid-column:span 6}.s4{grid-column:span 4}.s8{grid-column:span 8}}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);font-weight:700;margin-bottom:14px}
.hero{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.power{width:88px;height:88px;border-radius:50%;border:none;cursor:pointer;font-size:34px;background:var(--chip);color:var(--mut);transition:.2s}
.power.on{background:var(--blue);color:#fff;box-shadow:0 8px 24px rgba(20,40,160,.35)}
.temp{display:flex;align-items:center;gap:14px}
.temp .v{font-size:64px;font-weight:300;letter-spacing:-.03em;min-width:150px;text-align:center}
.temp .v small{font-size:24px;color:var(--mut)}
.rb{width:52px;height:52px;border-radius:50%;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:26px;cursor:pointer}
.rb:active{transform:scale(.95)}
.state{margin-left:auto;text-align:right}
.state .big{font-size:20px;font-weight:700}
.state .mut{color:var(--mut);font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:10px 16px;border-radius:14px;cursor:pointer;font-weight:600;font-size:14px;transition:.15s}
.chip:hover{border-color:var(--blue2)}
.chip.on{background:var(--blue);border-color:var(--blue);color:#fff}
.chip:disabled{opacity:.4;cursor:not-allowed}
.hint{color:var(--mut);font-size:12px;margin-top:10px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.kpi{background:var(--chip);border-radius:14px;padding:14px}
.kpi .l{color:var(--mut);font-size:12px}
.kpi .n{font-size:24px;font-weight:700;margin-top:2px}
.kpi .n small{font-size:13px;color:var(--mut);font-weight:500}
.gauge{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.ring{--p:0;width:130px;height:130px;border-radius:50%;display:grid;place-items:center;
background:conic-gradient(var(--c,var(--blue)) calc(var(--p)*1%),var(--chip) 0)}
.ring>div{width:104px;height:104px;border-radius:50%;background:var(--card);display:grid;place-items:center;font-size:26px;font-weight:700}
.rows{display:grid;gap:8px;flex:1;min-width:200px}
.row{display:flex;justify-content:space-between;border-bottom:1px dashed var(--line);padding:6px 0}
.row span:first-child{color:var(--mut)}
.btn{border:none;background:var(--blue);color:#fff;padding:10px 18px;border-radius:12px;font-weight:700;cursor:pointer}
.btn.ghost{background:var(--chip);color:var(--ink)}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
.badge.ok{background:rgba(15,157,88,.12);color:var(--ok)}.badge.bad{background:rgba(220,38,38,.12);color:var(--bad)}
.badge.warn{background:rgba(245,158,11,.15);color:var(--warn)}
.tog{position:relative;width:48px;height:28px;border-radius:999px;background:var(--line);border:none;cursor:pointer}
.tog::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:.2s}
.tog.on{background:var(--blue)}.tog.on::after{left:23px}
.logbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
select{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:8px}
.log{background:#0b0d12;color:#cbd5e1;border-radius:14px;padding:12px;height:420px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace}
.log div{white-space:pre-wrap;word-break:break-word}
.lE{color:#f87171}.lW{color:#fbbf24}.lI{color:#86efac}.lC{color:#c4b5fd}.lD{color:#93c5fd}.lV{color:#94a3b8}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:12px;opacity:0;transition:.25s;pointer-events:none;font-weight:600}
.toast.show{opacity:1}
footer{grid-column:span 12;text-align:center;color:var(--mut);font-size:12px}
`;

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const enc = id => id.split('/').map(encodeURIComponent).join('/');
const num = (id, d = 1) => { const v = st[id]?.value; return typeof v === 'number' && !isNaN(v) ? v.toFixed(d) : '–'; };
function toast(t) { const el = $('.toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 1800); }
async function post(path) {
  try {
    const r = await fetch('/' + path, { method: 'POST', body: '' });
    if (!r.ok) throw new Error(r.status);
  } catch (e) { toast('Commando mislukt (' + e.message + ')'); }
}
const climateSet = q => post(enc(fid(CLIMATE)) + '/set?' + new URLSearchParams(q));
const fmtUptime = s => { if (typeof s !== 'number') return '–'; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + h + 'u ' + m + 'm'; };

// ---------- opbouw ----------
function shell() {
  document.title = 'HVAC Local';
  const icon = document.createElement('link'); icon.rel = 'icon';
  icon.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b63c5"/><g fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(6,4) scale(.82)"><rect x="6" y="12" width="52" height="22" rx="6"/><path d="M13 27h38"/><path d="M20 40c-3 4 3 7 0 12M32 40c-3 4 3 7 0 12M44 40c-3 4 3 7 0 12"/></g></svg>');
  document.head.appendChild(icon);
  const meta = document.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width,initial-scale=1'; document.head.appendChild(meta);
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  document.body.innerHTML = `
  <header><div class="bar">
    ${LOGO}<span class="sub" id="unit">Airco</span>
    <span class="conn"><span class="dot" id="dot"></span><span id="connt">verbinden…</span></span>
    <nav><a href="#bediening" data-p="bediening">Bediening</a><a href="#onderhoud" data-p="onderhoud">Onderhoud</a></nav>
  </div></header>
  <main id="p-bediening"></main><main id="p-onderhoud" hidden></main>
  <div class="toast"></div>`;
  buildControl(); buildMaint(); route();
  window.addEventListener('hashchange', route);
}

function route() {
  const p = (location.hash || '#bediening').slice(1) === 'onderhoud' ? 'onderhoud' : 'bediening';
  $('#p-bediening').hidden = p !== 'bediening'; $('#p-onderhoud').hidden = p !== 'onderhoud';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.p === p));
  if (p === 'onderhoud') { const l = $('#log'); l.scrollTop = l.scrollHeight; }
}

const chips = (key, items) => `<div class="chips" data-k="${key}">${items.map(([v, l, ic]) =>
  `<button class="chip" data-v="${v}">${ic ? ic + ' ' : ''}${l}</button>`).join('')}</div>`;

function buildControl() {
  $('#p-bediening').innerHTML = `
  <section class="card"><div class="hero">
    <button class="power" id="pwr" title="Aan/uit">⏻</button>
    <div class="temp"><button class="rb" id="tm">−</button>
      <div class="v"><span id="tgt">–</span><small>°C</small></div>
      <button class="rb" id="tp">+</button></div>
    <div class="state"><div class="big" id="stmode">–</div><div class="mut" id="stsub">–</div></div>
  </div></section>
  <section class="card s6"><h2>Modus</h2>${chips('mode', MODES)}</section>
  <section class="card s6"><h2>Ventilator</h2>${chips('fan', FANS)}</section>
  <section class="card s8"><h2>Speciale modus</h2>${chips('preset', PRESETS)}
    <div class="hint">WindFree werkt enkel bij koelen of drogen. Fast/Quiet afhankelijk van de modus.</div></section>
  <section class="card s4"><h2>Windrichting</h2>${chips('swing', SWINGS)}</section>
  <section class="card"><h2>Klimaat & energie</h2><div class="kpis">
    <div class="kpi"><div class="l">Binnen</div><div class="n"><span id="k-room">–</span><small> °C</small></div></div>
    <div class="kpi"><div class="l">Luchtvochtigheid</div><div class="n"><span id="k-hum">–</span><small> %</small></div></div>
    <div class="kpi"><div class="l">Buiten</div><div class="n"><span id="k-out">–</span><small> °C</small></div></div>
    <div class="kpi"><div class="l">Vermogen buitenunit</div><div class="n"><span id="k-pw">–</span><small> W</small></div></div>
    <div class="kpi"><div class="l">Energie totaal</div><div class="n"><span id="k-en">–</span><small> kWh</small></div></div>
  </div></section>`;

  $('#pwr').onclick = () => {
    const m = st[CLIMATE]?.mode;
    climateSet({ mode: m && m !== 'OFF' ? 'off' : lastOnMode });
  };
  const bump = d => {
    const cur = pendingTarget ?? parseFloat(st[CLIMATE]?.target_temperature);
    if (isNaN(cur)) return;
    const s = tstep();
    pendingTarget = Math.min(TMAX, Math.max(TMIN, Math.round(cur / s) * s + d * s));
    $('#tgt').textContent = fmtT(pendingTarget);
    clearTimeout(targetTimer);
    targetTimer = setTimeout(() => { climateSet({ target_temperature: pendingTarget }); setTimeout(() => pendingTarget = null, 4000); }, 600);
  };
  $('#tm').onclick = () => bump(-1); $('#tp').onclick = () => bump(1);
  $('#p-bediening').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const k = b.parentElement.dataset.k, v = b.dataset.v;
    if (k === 'mode') { lastOnMode = v; climateSet({ mode: v }); }
    if (k === 'fan') climateSet({ fan_mode: v });
    if (k === 'preset') climateSet({ preset: v });
    if (k === 'swing') climateSet({ swing_mode: v.toLowerCase() });
    b.classList.add('on');
  });
}

function buildMaint() {
  $('#p-onderhoud').innerHTML = `
  <section class="card s6"><h2>Filter</h2><div class="gauge">
    <div class="ring" id="ring"><div id="fpct">–</div></div>
    <div class="rows">
      <div class="row"><span>Status</span><span id="fstat">–</span></div>
      <div class="row"><span>Gebruikt</span><span><span id="fh">–</span> u</span></div>
      <div class="row"><span>Capaciteit</span><span><span id="fcap">–</span> u</span></div>
      <div style="margin-top:8px"><button class="btn" id="freset">Filter resetten</button></div>
    </div></div>
    <div class="hint">Reset na het reinigen van het filter.</div></section>
  <section class="card s6"><h2>Systeem</h2><div class="rows">
    <div class="row"><span>Foutcode</span><span id="err">–</span></div>
    <div class="row"><span>Verdamper in / uit</span><span><span id="evi">–</span> / <span id="evo">–</span> °C</span></div>
    <div class="row"><span>Automatische reiniging</span><button class="tog" id="clean" title="Automatische reiniging"></button></div>
    <div class="row"><span>Wifi-signaal</span><span id="wifi">–</span></div>
    <div class="row"><span>Uptime bridge</span><span id="up">–</span></div>
    <div class="row"><span>IP / MAC</span><span><span id="ip">–</span> · <span id="mac">–</span></span></div>
    <div class="row"><span>Busadressen</span><span>binnen 20.00.00 · buiten 10.00.00 (NASA)</span></div>
    <div class="row"><span>Bridge herstarten</span><button class="btn ghost" id="reboot">Herstarten</button></div>
  </div></section>
  <section class="card"><h2>Live logboek</h2>
    <div class="logbar">
      <select id="lvl"><option value="ALL">Alle niveaus</option><option value="EW">Enkel fouten & waarschuwingen</option><option value="EWI">+ info</option></select>
      <button class="btn ghost" id="lpause">Pauzeren</button>
      <button class="btn ghost" id="lclear">Wissen</button>
      <button class="btn ghost" id="ldl">Downloaden</button>
    </div>
    <div class="log" id="log"></div>
    <div class="hint">De laatste ${LOGKEEP} regels worden in deze browser bewaard en blijven zichtbaar na herladen. De bridge zelf bewaart geen logs.</div></section>`;

  $('#freset').onclick = () => { if (confirm('Filterteller resetten? Doe dit enkel na het reinigen van het filter.')) post(enc(fid(E.fReset)) + '/press').then(() => toast('Filter gereset')); };
  $('#reboot').onclick = () => {
    if (!confirm('Bridge herstarten? De airco blijft gewoon werken; de pagina is ±15 s weg.')) return;
    // de ESP kan herstarten vóór het antwoord aankomt → fouten hier negeren
    fetch('/' + enc(fid(E.reboot)) + '/press', { method: 'POST', body: '' }).catch(() => {});
    toast('Bridge herstart…');
  };
  $('#clean').onclick = () => post(enc(fid(E.clean)) + (st[E.clean]?.value ? '/turn_off' : '/turn_on'));
  $('#lvl').onchange = e => { logLevel = e.target.value; renderLog(true); };
  $('#lpause').onclick = e => { logPaused = !logPaused; e.target.textContent = logPaused ? 'Hervatten' : 'Pauzeren'; if (!logPaused) renderLog(true); };
  $('#lclear').onclick = () => { logs.length = 0; saveLogs(); renderLog(true); };
  $('#ldl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([logs.map(l => l.t).join('\n')], { type: 'text/plain' }));
    a.download = 'samsung-ac-living-log.txt'; a.click();
  };
}

// ---------- weergave ----------
const setChips = (k, val) => document.querySelectorAll(`[data-k="${k}"] .chip`).forEach(b => b.classList.toggle('on', val != null && b.dataset.v.toUpperCase() === String(val).toUpperCase()));
const txt = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };

function render() {
  if (unitName) { txt('#unit', unitName); document.title = unitName + ' · HVAC Local'; }
  const c = st[CLIMATE];
  if (c) {
    const on = c.mode && c.mode !== 'OFF';
    if (on) lastOnMode = c.mode.toLowerCase();
    $('#pwr').classList.toggle('on', on);
    const tg = parseFloat(c.target_temperature);
    if (pendingTarget == null) txt('#tgt', isNaN(tg) ? '–' : fmtT(tg));
    const ml = MODES.find(m => m[0].toUpperCase() === c.mode);
    txt('#stmode', on ? (ml ? ml[1] : c.mode) : 'Uit');
    const fan = c.custom_fan_mode || c.fan_mode, pre = c.custom_preset || c.preset;
    const fl = FANS.find(f => f[0].toUpperCase() === String(fan).toUpperCase());
    const pl = PRESETS.find(p => p[0].toUpperCase() === String(pre).toUpperCase());
    txt('#stsub', `Binnen ${isNaN(parseFloat(c.current_temperature)) ? '–' : c.current_temperature} °C · ventilator ${fl ? fl[1].toLowerCase() : '–'}${pl && pl[0] !== 'NONE' ? ' · ' + pl[1] : ''}`);
    setChips('mode', on ? c.mode : null);
    setChips('fan', fan); setChips('preset', pre || 'NONE'); setChips('swing', c.swing_mode);
    const wf = on && /^(COOL|DRY)$/.test(c.mode);
    const wfb = $('[data-k="preset"] [data-v="WindFree"]'); if (wfb) wfb.disabled = !wf && pre !== 'WindFree';
  }
  txt('#k-room', num(E.room)); txt('#k-hum', num(E.hum, 0)); txt('#k-out', num(E.out));
  txt('#k-pw', num(E.power, 0)); txt('#k-en', num(E.energy, 1));
  // onderhoud
  const p = st[E.fPct]?.value;
  const ring = $('#ring');
  if (typeof p === 'number') { ring.style.setProperty('--p', Math.min(100, p)); ring.style.setProperty('--c', p >= 100 ? 'var(--bad)' : p >= 80 ? 'var(--warn)' : 'var(--blue)'); txt('#fpct', Math.round(p) + '%'); }
  txt('#fh', num(E.fH, 0)); txt('#fcap', num(E.fCap, 0));
  const w = st[E.fWarn]?.value;
  $('#fstat').innerHTML = w === true ? '<span class="badge bad">Reinigen</span>' : w === false ? '<span class="badge ok">In orde</span>' : '–';
  const er = st[E.err]?.value;
  $('#err').innerHTML = er === 0 ? '<span class="badge ok">Geen fout</span>' : typeof er === 'number' ? `<span class="badge bad">Code ${er}</span>` : '–';
  txt('#evi', num(E.evaIn)); txt('#evo', num(E.evaOut));
  $('#clean').classList.toggle('on', !!st[E.clean]?.value);
  const ws = st[E.wifi]?.value;
  $('#wifi').innerHTML = typeof ws === 'number' ? `${ws} dBm <span class="badge ${ws > -65 ? 'ok' : ws > -75 ? 'warn' : 'bad'}">${ws > -65 ? 'goed' : ws > -75 ? 'matig' : 'zwak'}</span>` : '–';
  txt('#up', fmtUptime(st[E.up]?.value));
  txt('#ip', st[E.ip]?.value ?? '–'); txt('#mac', st[E.mac]?.value ?? '–');
}

const LVL = { EW: /[EW]/, EWI: /[EWI]/ };
function addLog(raw) {
  const t = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const m = t.match(/\]\[([EWICDV])\]/);
  const now = new Date().toLocaleTimeString('nl-BE', { hour12: false });
  logs.push({ t: t.startsWith('[') ? t : `[${now}] ${t}`, l: m ? m[1] : 'V' });
  if (logs.length > 600) logs.shift();
  saveLogs();
  if (!logPaused) renderLog(false);
}
function renderLog(full) {
  const box = $('#log'); if (!box) return;
  const ok = l => logLevel === 'ALL' || LVL[logLevel].test(l.l);
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const line = l => { const d = document.createElement('div'); d.className = 'l' + l.l; d.textContent = l.t; return d; };
  if (full) { box.textContent = ''; logs.filter(ok).forEach(l => box.appendChild(line(l))); }
  else { const l = logs[logs.length - 1]; if (ok(l)) box.appendChild(line(l)); while (box.childElementCount > 600) box.firstChild.remove(); }
  if (atEnd || full) box.scrollTop = box.scrollHeight;
}

// ---------- live verbinding ----------
let rt = 0;
function connect() {
  const es = new EventSource('/events');
  const setConn = ok => { $('#dot').classList.toggle('ok', ok); txt('#connt', ok ? 'verbonden' : 'verbinding verbroken…'); };
  es.addEventListener('state', e => { try { const d = JSON.parse(e.data); if (d.id) { const k = shortId(d.id); if (full[k] && full[k] !== d.id) return; full[k] = d.id; if (k === CLIMATE && d.id !== k) unitName = d.id.split('/')[1]; st[k] = { ...st[k], ...d }; clearTimeout(rt); rt = setTimeout(render, 50); } } catch (_) { } });
  es.addEventListener('log', e => addLog(e.data));
  es.addEventListener('ping', () => setConn(true));
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
}

shell(); renderLog(true); connect();
