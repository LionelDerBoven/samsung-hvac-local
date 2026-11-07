// Samsung HVAC Local — local control page (runs entirely on the ESP, no internet needed).
// Talks to the ESPHome web_server: live state via SSE (/events), commands via POST.

// Entities per the bridge contract (CONTRACT.md): domain + fixed English role name.
// With sub-devices the real id is "domain/<unit>/<name>"; it is mapped on arrival (see fid()).
const CLIMATE = 'climate/Climate';
const E = {
  room: 'sensor/Room temperature', hum: 'sensor/Room humidity', out: 'sensor/Outdoor temperature',
  evaIn: 'sensor/EVA in temperature', evaOut: 'sensor/EVA out temperature', power: 'sensor/Power',
  energy: 'sensor/Energy', err: 'sensor/Error code',
  fPct: 'sensor/Filter usage', fH: 'sensor/Filter hours', fCap: 'sensor/Filter capacity',
  fWarn: 'binary_sensor/Filter alarm', fReset: 'button/Filter reset', reboot: 'button/Restart',
  clean: 'switch/Auto clean', bus: 'binary_sensor/Bus active',
  wifi: 'sensor/WiFi signal', up: 'sensor/Uptime', ip: 'text_sensor/IP address', mac: 'text_sensor/MAC address',
};
const full = {};           // short role id → full id (first unit wins on multi-split)
let unitName = '';
const shortId = id => { const p = id.split('/'); return p.length > 2 ? p[0] + '/' + p[p.length - 1] : id; };
const fid = id => full[id] || id;

// ---------- preferences (per browser) ----------
const pref = {
  get: k => { try { return localStorage.getItem('hvl-' + k); } catch (_) { return null; } },
  set: (k, v) => { try { localStorage.setItem('hvl-' + k, v); } catch (_) { } },
};

// ---------- translations ----------
const I18N = {
  en: {
    _name: 'English', connecting: 'connecting…', connected: 'connected', lost: 'connection lost…',
    control: 'Control', maint: 'Maintenance', onoff: 'On/off', off: 'Off',
    mode: 'Mode', fan: 'Fan', preset: 'Special mode', swing: 'Air direction',
    presetHint: 'WindFree only works in cool or dry mode. Fast and Quiet depend on the mode.',
    climate: 'Climate & energy', indoor: 'Indoor', humidity: 'Humidity', outdoor: 'Outdoor',
    odPower: 'Outdoor unit power', energy: 'Total energy', stsub: 'Indoor {t} °C · fan {f}',
    m: { cool: 'Cool', dry: 'Dry', fan_only: 'Fan', auto: 'Auto', heat: 'Heat' },
    f: { AUTO: 'Auto', LOW: 'Low', MIDDLE: 'Medium', HIGH: 'High', Turbo: 'Turbo' },
    p: { NONE: 'None', WindFree: 'WindFree', Quiet: 'Quiet', Fast: 'Fast', ECO: 'Eco', SLEEP: 'Sleep', LongReach: 'Long reach' },
    s: { OFF: 'Fixed', VERTICAL: 'Vertical', HORIZONTAL: 'Horizontal', BOTH: 'Both' },
    filter: 'Filter', status: 'Status', used: 'Used', capacity: 'Capacity', h: 'h',
    fReset: 'Reset filter', fHint: 'Reset after cleaning the filter.', fClean: 'Clean', fOk: 'OK',
    fConfirm: 'Reset the filter counter? Only do this after cleaning the filter.', fDone: 'Filter reset',
    system: 'System', errCode: 'Error code', noErr: 'No error', code: 'Code {c}', eva: 'Evaporator in / out',
    autoClean: 'Auto clean', bus: 'Bus (F1/F2)', busOk: 'active', busQuiet: 'quiet',
    wifi: 'Wi-Fi signal', good: 'good', fair: 'fair', weak: 'weak',
    uptime: 'Bridge uptime', restartBridge: 'Restart bridge', restart: 'Restart',
    rConfirm: 'Restart the bridge? The AC keeps running; this page is gone for about 15 s.', rDone: 'Bridge restarting…',
    log: 'Live log', lvlAll: 'All levels', lvlEW: 'Errors & warnings only', lvlEWI: '+ info',
    pause: 'Pause', resume: 'Resume', clear: 'Clear', download: 'Download',
    logHint: 'The last {n} lines are kept in this browser and survive a reload. The bridge itself stores no logs.',
    failed: 'Command failed ({e})', theme: 'Theme', tAuto: 'automatic', tLight: 'light', tDark: 'dark', lang: 'Language',
  },
  nl: {
    _name: 'Nederlands', connecting: 'verbinden…', connected: 'verbonden', lost: 'verbinding verbroken…',
    control: 'Bediening', maint: 'Onderhoud', onoff: 'Aan/uit', off: 'Uit',
    mode: 'Modus', fan: 'Ventilator', preset: 'Speciale modus', swing: 'Windrichting',
    presetHint: 'WindFree werkt enkel bij koelen of drogen. Fast en Quiet hangen af van de modus.',
    climate: 'Klimaat & energie', indoor: 'Binnen', humidity: 'Luchtvochtigheid', outdoor: 'Buiten',
    odPower: 'Vermogen buitenunit', energy: 'Energie totaal', stsub: 'Binnen {t} °C · ventilator {f}',
    m: { cool: 'Koelen', dry: 'Drogen', fan_only: 'Ventileren', auto: 'Auto', heat: 'Verwarmen' },
    f: { AUTO: 'Auto', LOW: 'Laag', MIDDLE: 'Midden', HIGH: 'Hoog', Turbo: 'Turbo' },
    p: { NONE: 'Geen', WindFree: 'WindFree', Quiet: 'Stil', Fast: 'Snel', ECO: 'Eco', SLEEP: 'Slapen', LongReach: 'Lange reikwijdte' },
    s: { OFF: 'Vast', VERTICAL: 'Verticaal', HORIZONTAL: 'Horizontaal', BOTH: 'Beide' },
    filter: 'Filter', status: 'Status', used: 'Gebruikt', capacity: 'Capaciteit', h: 'u',
    fReset: 'Filter resetten', fHint: 'Reset na het reinigen van het filter.', fClean: 'Reinigen', fOk: 'In orde',
    fConfirm: 'Filterteller resetten? Doe dit enkel na het reinigen van het filter.', fDone: 'Filter gereset',
    system: 'Systeem', errCode: 'Foutcode', noErr: 'Geen fout', code: 'Code {c}', eva: 'Verdamper in / uit',
    autoClean: 'Automatische reiniging', bus: 'Bus (F1/F2)', busOk: 'actief', busQuiet: 'stil',
    wifi: 'Wifi-signaal', good: 'goed', fair: 'matig', weak: 'zwak',
    uptime: 'Uptime bridge', restartBridge: 'Bridge herstarten', restart: 'Herstarten',
    rConfirm: 'Bridge herstarten? De airco blijft gewoon werken; de pagina is ±15 s weg.', rDone: 'Bridge herstart…',
    log: 'Live logboek', lvlAll: 'Alle niveaus', lvlEW: 'Enkel fouten & waarschuwingen', lvlEWI: '+ info',
    pause: 'Pauzeren', resume: 'Hervatten', clear: 'Wissen', download: 'Downloaden',
    logHint: 'De laatste {n} regels worden in deze browser bewaard en blijven zichtbaar na herladen. De bridge zelf bewaart geen logs.',
    failed: 'Commando mislukt ({e})', theme: 'Thema', tAuto: 'automatisch', tLight: 'licht', tDark: 'donker', lang: 'Taal',
  },
  fr: {
    _name: 'Français', connecting: 'connexion…', connected: 'connecté', lost: 'connexion perdue…',
    control: 'Commande', maint: 'Entretien', onoff: 'Marche/arrêt', off: 'Arrêt',
    mode: 'Mode', fan: 'Ventilateur', preset: 'Mode spécial', swing: "Direction de l'air",
    presetHint: 'WindFree ne fonctionne qu’en mode froid ou déshumidification. Rapide et Silencieux dépendent du mode.',
    climate: 'Climat & énergie', indoor: 'Intérieur', humidity: 'Humidité', outdoor: 'Extérieur',
    odPower: 'Puissance unité extérieure', energy: 'Énergie totale', stsub: 'Intérieur {t} °C · ventilateur {f}',
    m: { cool: 'Froid', dry: 'Déshumidification', fan_only: 'Ventilation', auto: 'Auto', heat: 'Chauffage' },
    f: { AUTO: 'Auto', LOW: 'Faible', MIDDLE: 'Moyen', HIGH: 'Élevé', Turbo: 'Turbo' },
    p: { NONE: 'Aucun', WindFree: 'WindFree', Quiet: 'Silencieux', Fast: 'Rapide', ECO: 'Éco', SLEEP: 'Nuit', LongReach: 'Longue portée' },
    s: { OFF: 'Fixe', VERTICAL: 'Vertical', HORIZONTAL: 'Horizontal', BOTH: 'Les deux' },
    filter: 'Filtre', status: 'Statut', used: 'Utilisé', capacity: 'Capacité', h: 'h',
    fReset: 'Réinitialiser le filtre', fHint: 'Réinitialisez après avoir nettoyé le filtre.', fClean: 'À nettoyer', fOk: 'OK',
    fConfirm: 'Réinitialiser le compteur du filtre ? Uniquement après avoir nettoyé le filtre.', fDone: 'Filtre réinitialisé',
    system: 'Système', errCode: "Code d'erreur", noErr: 'Aucune erreur', code: 'Code {c}', eva: 'Évaporateur entrée / sortie',
    autoClean: 'Nettoyage automatique', bus: 'Bus (F1/F2)', busOk: 'actif', busQuiet: 'silencieux',
    wifi: 'Signal Wi-Fi', good: 'bon', fair: 'moyen', weak: 'faible',
    uptime: 'Temps de fonctionnement du pont', restartBridge: 'Redémarrer le pont', restart: 'Redémarrer',
    rConfirm: 'Redémarrer le pont ? Le climatiseur continue de fonctionner ; la page est indisponible environ 15 s.', rDone: 'Redémarrage du pont…',
    log: 'Journal en direct', lvlAll: 'Tous les niveaux', lvlEW: 'Erreurs et avertissements', lvlEWI: '+ info',
    pause: 'Pause', resume: 'Reprendre', clear: 'Effacer', download: 'Télécharger',
    logHint: 'Les {n} dernières lignes sont conservées dans ce navigateur et restent après un rechargement. Le pont lui-même ne conserve aucun journal.',
    failed: 'Échec de la commande ({e})', theme: 'Thème', tAuto: 'automatique', tLight: 'clair', tDark: 'sombre', lang: 'Langue',
  },
};
const LOCALE = { en: 'en-GB', nl: 'nl-BE', fr: 'fr-BE' };
let lang = (() => {
  const saved = pref.get('lang');
  if (I18N[saved]) return saved;
  const nav = (navigator.languages || [navigator.language || 'en']).map(l => String(l).slice(0, 2).toLowerCase());
  return nav.find(l => I18N[l]) || 'en';
})();
const t = (k, vars) => {
  const v = I18N[lang][k] ?? I18N.en[k] ?? k;
  return vars ? v.replace(/\{(\w+)\}/g, (_, n) => vars[n]) : v;
};

// Values sent to the bridge; labels come from I18N.
const MODES = [['cool', '❄'], ['heat', '☀'], ['dry', '💧'], ['fan_only', '🌀'], ['auto', 'A']];
const FANS = ['AUTO', 'LOW', 'MIDDLE', 'HIGH', 'Turbo'];
const PRESETS = ['NONE', 'WindFree', 'Quiet', 'Fast', 'ECO', 'SLEEP', 'LongReach'];
const SWINGS = ['OFF', 'VERTICAL', 'HORIZONTAL', 'BOTH'];
const label = (group, v) => { const g = t(group); const k = Object.keys(g).find(x => x.toUpperCase() === String(v).toUpperCase()); return k ? g[k] : null; };

// Target range and step come from the bridge (climate traits), with the remote's defaults as fallback.
const climNum = (k, d) => { const v = parseFloat(st[CLIMATE]?.[k]); return isNaN(v) ? d : v; };
const tstep = () => climNum('step', 1) || 1;
const tmin = () => climNum('min_temp', 16), tmax = () => climNum('max_temp', 30);
const fmtT = v => (tstep() < 1 ? v.toFixed(1) : String(Math.round(v)));
const LOGO = `<svg class="logo" viewBox="0 0 168 40" role="img" aria-label="HVAC Local"><g fill="none" stroke="var(--blue)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(2,2) scale(.56)"><rect x="6" y="12" width="52" height="22" rx="6"/><path d="M13 27h38"/><path d="M20 40c-3 4 3 7 0 12M32 40c-3 4 3 7 0 12M44 40c-3 4 3 7 0 12"/></g><text x="44" y="28" font-size="22" font-weight="800" fill="currentColor">HVAC <tspan fill="var(--blue)" font-weight="600">Local</tspan></text></svg>`;

const st = {};            // entity id → last state
let lastOnMode = 'cool';  // mode to return to when switching on
let pendingTarget = null, targetTimer = null;
const LOGKEY = 'sac-log-v1', LOGKEEP = 300;
const logs = (() => { try { return JSON.parse(localStorage.getItem(LOGKEY)) || []; } catch (_) { return []; } })();
let saveT = null;
const saveLogs = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(LOGKEY, JSON.stringify(logs.slice(-LOGKEEP))); } catch (_) { } }, 1000); };
let logPaused = false, logLevel = 'ALL';

// ---------- style ----------
const DARK = '--bg:#0b0d12;--card:#151821;--ink:#f3f4f6;--mut:#9ca3af;--line:#262b38;--blue:#5aa2f0;--blue2:#7cb6f4;--chip:#1c2233;--shadow:none;color-scheme:dark';
const css = `
:root{--bg:#f4f5f7;--card:#fff;--ink:#111;--mut:#6b7280;--line:#e5e7eb;--blue:#0b63c5;--blue2:#2f80e0;
--ok:#0f9d58;--warn:#f59e0b;--bad:#dc2626;--chip:#eef1fb;--shadow:0 1px 2px rgba(0,0,0,.04),0 6px 24px rgba(11,99,197,.06);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
body{background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:1080px;margin:auto;display:flex;align-items:center;gap:12px 16px;padding:12px 16px;flex-wrap:wrap}
.logo{height:28px;width:auto;display:block;color:var(--ink)}
.sub{color:var(--mut);font-size:13px;border-left:1px solid var(--line);padding-left:14px}
nav{margin-left:auto;display:flex;gap:4px;background:var(--chip);padding:4px;border-radius:999px}
nav a{padding:7px 16px;border-radius:999px;color:var(--mut);text-decoration:none;font-weight:600;font-size:14px}
nav a.on{background:var(--card);color:var(--blue);box-shadow:var(--shadow)}
.prefs{display:flex;gap:6px;align-items:center}
.ib{height:34px;min-width:34px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;font-size:16px;display:grid;place-items:center}
.ib:hover{border-color:var(--blue2)}
.prefs select{height:34px;border-radius:999px;padding:0 10px;font-weight:600;font-size:13px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--bad);display:inline-block;margin-right:6px}
.dot.ok{background:var(--ok)}
.conn{font-size:12px;color:var(--mut);display:flex;align-items:center}
main{max-width:1080px;margin:auto;padding:20px 16px 48px;display:grid;gap:16px;grid-template-columns:repeat(12,1fr)}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:var(--shadow);grid-column:span 12;min-width:0}
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
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px dashed var(--line);padding:6px 0}
.row span:first-child{color:var(--mut)}
.row>span:last-child{text-align:right;overflow-wrap:anywhere}
.btn{border:none;background:var(--blue);color:#fff;padding:10px 18px;border-radius:12px;font-weight:700;cursor:pointer}
.btn.ghost{background:var(--chip);color:var(--ink)}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
.badge.ok{background:rgba(15,157,88,.12);color:var(--ok)}.badge.bad{background:rgba(220,38,38,.12);color:var(--bad)}
.badge.warn{background:rgba(245,158,11,.15);color:var(--warn)}
.tog{position:relative;flex:none;width:48px;height:28px;border-radius:999px;background:var(--line);border:none;cursor:pointer}
.tog::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:.2s}
.tog.on{background:var(--blue)}.tog.on::after{left:23px}
.logbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
select{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:8px}
.log{background:#0b0d12;color:#cbd5e1;border-radius:14px;padding:12px;height:420px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace}
.log div{white-space:pre-wrap;word-break:break-word}
.lE{color:#f87171}.lW{color:#fbbf24}.lI{color:#86efac}.lC{color:#c4b5fd}.lD{color:#93c5fd}.lV{color:#94a3b8}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:10px 18px;border-radius:12px;opacity:0;transition:.25s;pointer-events:none;font-weight:600}
.toast.show{opacity:1}
@media(max-width:600px){.temp .v{font-size:52px;min-width:120px}.state{margin-left:0;text-align:left}}
`;

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const enc = id => id.split('/').map(encodeURIComponent).join('/');
const num = (id, d = 1) => { const v = st[id]?.value; return typeof v === 'number' && !isNaN(v) ? v.toFixed(d) : '–'; };
function toast(msg) { const el = $('.toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 1800); }
async function post(path) {
  try {
    const r = await fetch('/' + path, { method: 'POST', body: '' });
    if (!r.ok) throw new Error(r.status);
  } catch (e) { toast(t('failed', { e: e.message })); }
}
const climateSet = q => post(enc(fid(CLIMATE)) + '/set?' + new URLSearchParams(q));
const fmtUptime = s => { if (typeof s !== 'number') return '–'; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + h + t('h') + ' ' + m + 'm'; };

// ---------- theme: automatic (follows the system) → light → dark ----------
const THEMES = [['auto', '◐', 'tAuto'], ['light', '☀', 'tLight'], ['dark', '☾', 'tDark']];
let theme = THEMES.some(x => x[0] === pref.get('theme')) ? pref.get('theme') : 'auto';
function applyTheme() {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  const b = $('#theme'); if (!b) return;
  const [, icon, key] = THEMES.find(x => x[0] === theme);
  b.textContent = icon; b.title = `${t('theme')}: ${t(key)}`; b.setAttribute('aria-label', b.title);
}

// ---------- layout ----------
function shell() {
  document.title = 'HVAC Local';
  const icon = document.createElement('link'); icon.rel = 'icon';
  icon.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b63c5"/><g fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(6,4) scale(.82)"><rect x="6" y="12" width="52" height="22" rx="6"/><path d="M13 27h38"/><path d="M20 40c-3 4 3 7 0 12M32 40c-3 4 3 7 0 12M44 40c-3 4 3 7 0 12"/></g></svg>');
  document.head.appendChild(icon);
  const meta = document.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width,initial-scale=1'; document.head.appendChild(meta);
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  document.body.innerHTML = `
  <header><div class="bar">
    ${LOGO}<span class="sub" id="unit">AC</span>
    <span class="conn"><span class="dot" id="dot"></span><span id="connt"></span></span>
    <nav><a href="#control" data-p="control" id="n-control"></a><a href="#maintenance" data-p="maintenance" id="n-maint"></a></nav>
    <div class="prefs">
      <select id="lang">${Object.keys(I18N).map(l => `<option value="${l}">${l.toUpperCase()}</option>`).join('')}</select>
      <button class="ib" id="theme"></button>
    </div>
  </div></header>
  <main id="p-control"></main><main id="p-maintenance" hidden></main>
  <div class="toast"></div>`;
  $('#lang').onchange = e => { lang = e.target.value; pref.set('lang', lang); build(); };
  $('#theme').onclick = () => { theme = THEMES[(THEMES.findIndex(x => x[0] === theme) + 1) % THEMES.length][0]; pref.set('theme', theme); applyTheme(); };
  // One delegated listener for all chips (the cards are rebuilt on a language change).
  $('#p-control').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    const k = b.parentElement.dataset.k, v = b.dataset.v;
    if (k === 'mode') { lastOnMode = v; climateSet({ mode: v }); }
    if (k === 'fan') climateSet({ fan_mode: v });
    if (k === 'preset') climateSet({ preset: v });
    if (k === 'swing') climateSet({ swing_mode: v.toLowerCase() });
    b.classList.add('on');
  });
  build();
  window.addEventListener('hashchange', route);
}

// (Re)builds every translated part of the page.
function build() {
  document.documentElement.lang = lang;
  $('#lang').value = lang;
  [...$('#lang').options].forEach(o => { o.title = I18N[o.value]._name; });
  $('#lang').title = t('lang');
  txt('#n-control', t('control')); txt('#n-maint', t('maint'));
  setConn(connOk);
  applyTheme();
  buildControl(); buildMaint(); route(); render(); renderLog(true);
}

function route() {
  const p = (location.hash || '#control').slice(1) === 'maintenance' ? 'maintenance' : 'control';
  $('#p-control').hidden = p !== 'control'; $('#p-maintenance').hidden = p !== 'maintenance';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.p === p));
  if (p === 'maintenance') { const l = $('#log'); l.scrollTop = l.scrollHeight; }
}

const chips = (key, group, items) => `<div class="chips" data-k="${key}">${items.map(it => {
  const [v, ic] = Array.isArray(it) ? it : [it];
  return `<button class="chip" data-v="${v}">${ic ? ic + ' ' : ''}${label(group, v)}</button>`;
}).join('')}</div>`;

function buildControl() {
  $('#p-control').innerHTML = `
  <section class="card"><div class="hero">
    <button class="power" id="pwr" title="${t('onoff')}" aria-label="${t('onoff')}">⏻</button>
    <div class="temp"><button class="rb" id="tm" aria-label="−">−</button>
      <div class="v"><span id="tgt">–</span><small>°C</small></div>
      <button class="rb" id="tp" aria-label="+">+</button></div>
    <div class="state"><div class="big" id="stmode">–</div><div class="mut" id="stsub">–</div></div>
  </div></section>
  <section class="card s6"><h2>${t('mode')}</h2>${chips('mode', 'm', MODES)}</section>
  <section class="card s6"><h2>${t('fan')}</h2>${chips('fan', 'f', FANS)}</section>
  <section class="card s8"><h2>${t('preset')}</h2>${chips('preset', 'p', PRESETS)}
    <div class="hint">${t('presetHint')}</div></section>
  <section class="card s4"><h2>${t('swing')}</h2>${chips('swing', 's', SWINGS)}</section>
  <section class="card"><h2>${t('climate')}</h2><div class="kpis">
    <div class="kpi"><div class="l">${t('indoor')}</div><div class="n"><span id="k-room">–</span><small> °C</small></div></div>
    <div class="kpi"><div class="l">${t('humidity')}</div><div class="n"><span id="k-hum">–</span><small> %</small></div></div>
    <div class="kpi"><div class="l">${t('outdoor')}</div><div class="n"><span id="k-out">–</span><small> °C</small></div></div>
    <div class="kpi"><div class="l">${t('odPower')}</div><div class="n"><span id="k-pw">–</span><small> W</small></div></div>
    <div class="kpi"><div class="l">${t('energy')}</div><div class="n"><span id="k-en">–</span><small> kWh</small></div></div>
  </div></section>`;

  $('#pwr').onclick = () => {
    const m = st[CLIMATE]?.mode;
    climateSet({ mode: m && m !== 'OFF' ? 'off' : lastOnMode });
  };
  const bump = d => {
    const cur = pendingTarget ?? parseFloat(st[CLIMATE]?.target_temperature);
    if (isNaN(cur)) return;
    const s = tstep();
    pendingTarget = Math.min(tmax(), Math.max(tmin(), Math.round(cur / s) * s + d * s));
    $('#tgt').textContent = fmtT(pendingTarget);
    clearTimeout(targetTimer);
    targetTimer = setTimeout(() => { climateSet({ target_temperature: pendingTarget }); setTimeout(() => pendingTarget = null, 4000); }, 600);
  };
  $('#tm').onclick = () => bump(-1); $('#tp').onclick = () => bump(1);
}

function buildMaint() {
  $('#p-maintenance').innerHTML = `
  <section class="card s6"><h2>${t('filter')}</h2><div class="gauge">
    <div class="ring" id="ring"><div id="fpct">–</div></div>
    <div class="rows">
      <div class="row"><span>${t('status')}</span><span id="fstat">–</span></div>
      <div class="row"><span>${t('used')}</span><span><span id="fh">–</span> ${t('h')}</span></div>
      <div class="row"><span>${t('capacity')}</span><span><span id="fcap">–</span> ${t('h')}</span></div>
      <div style="margin-top:8px"><button class="btn" id="freset">${t('fReset')}</button></div>
    </div></div>
    <div class="hint">${t('fHint')}</div></section>
  <section class="card s6"><h2>${t('system')}</h2><div class="rows">
    <div class="row"><span>${t('errCode')}</span><span id="err">–</span></div>
    <div class="row"><span>${t('eva')}</span><span><span id="evi">–</span> / <span id="evo">–</span> °C</span></div>
    <div class="row"><span>${t('autoClean')}</span><button class="tog" id="clean" title="${t('autoClean')}" aria-label="${t('autoClean')}"></button></div>
    <div class="row"><span>${t('bus')}</span><span id="bus">–</span></div>
    <div class="row"><span>${t('wifi')}</span><span id="wifi">–</span></div>
    <div class="row"><span>${t('uptime')}</span><span id="up">–</span></div>
    <div class="row"><span>IP / MAC</span><span><span id="ip">–</span> · <span id="mac">–</span></span></div>
    <div class="row"><span>${t('restartBridge')}</span><button class="btn ghost" id="reboot">${t('restart')}</button></div>
  </div></section>
  <section class="card"><h2>${t('log')}</h2>
    <div class="logbar">
      <select id="lvl"><option value="ALL">${t('lvlAll')}</option><option value="EW">${t('lvlEW')}</option><option value="EWI">${t('lvlEWI')}</option></select>
      <button class="btn ghost" id="lpause">${logPaused ? t('resume') : t('pause')}</button>
      <button class="btn ghost" id="lclear">${t('clear')}</button>
      <button class="btn ghost" id="ldl">${t('download')}</button>
    </div>
    <div class="log" id="log"></div>
    <div class="hint">${t('logHint', { n: LOGKEEP })}</div></section>`;

  $('#freset').onclick = () => { if (confirm(t('fConfirm'))) post(enc(fid(E.fReset)) + '/press').then(() => toast(t('fDone'))); };
  $('#reboot').onclick = () => {
    if (!confirm(t('rConfirm'))) return;
    // the ESP may restart before the reply arrives → ignore errors here
    fetch('/' + enc(fid(E.reboot)) + '/press', { method: 'POST', body: '' }).catch(() => {});
    toast(t('rDone'));
  };
  $('#clean').onclick = () => post(enc(fid(E.clean)) + (st[E.clean]?.value ? '/turn_off' : '/turn_on'));
  $('#lvl').value = logLevel;
  $('#lvl').onchange = e => { logLevel = e.target.value; renderLog(true); };
  $('#lpause').onclick = e => { logPaused = !logPaused; e.target.textContent = logPaused ? t('resume') : t('pause'); if (!logPaused) renderLog(true); };
  $('#lclear').onclick = () => { logs.length = 0; saveLogs(); renderLog(true); };
  $('#ldl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([logs.map(l => l.t).join('\n')], { type: 'text/plain' }));
    a.download = (unitName || 'hvac-local').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-log.txt'; a.click();
  };
}

// ---------- rendering ----------
const setChips = (k, val) => document.querySelectorAll(`[data-k="${k}"] .chip`).forEach(b => b.classList.toggle('on', val != null && b.dataset.v.toUpperCase() === String(val).toUpperCase()));
// Hide the chips the bridge does not offer (climate traits; sent with the first state event).
const showSupported = (k, list) => { if (!Array.isArray(list)) return; const ok = new Set(list.map(x => String(x).toUpperCase())); document.querySelectorAll(`[data-k="${k}"] .chip`).forEach(b => { b.hidden = !ok.has(b.dataset.v.toUpperCase()); }); };
const txt = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
const badge = (cls, text) => `<span class="badge ${cls}">${text}</span>`;

function render() {
  if (unitName) { txt('#unit', unitName); document.title = unitName + ' · HVAC Local'; }
  const c = st[CLIMATE];
  if (c) {
    const on = c.mode && c.mode !== 'OFF';
    if (on) lastOnMode = c.mode.toLowerCase();
    $('#pwr').classList.toggle('on', on);
    const tg = parseFloat(c.target_temperature);
    if (pendingTarget == null) txt('#tgt', isNaN(tg) ? '–' : fmtT(tg));
    txt('#stmode', on ? (label('m', c.mode) || c.mode) : t('off'));
    const fan = c.custom_fan_mode || c.fan_mode, pre = c.custom_preset || c.preset;
    const fl = label('f', fan), pl = label('p', pre);
    const cur = parseFloat(c.current_temperature);
    txt('#stsub', t('stsub', { t: isNaN(cur) ? '–' : cur.toFixed(1), f: fl ? fl.toLowerCase() : '–' })
      + (pl && String(pre).toUpperCase() !== 'NONE' ? ' · ' + pl : ''));
    setChips('mode', on ? c.mode : null);
    setChips('fan', fan); setChips('preset', pre || 'NONE'); setChips('swing', c.swing_mode);
    showSupported('mode', c.modes);
    showSupported('fan', c.fan_modes && [...c.fan_modes, ...(c.custom_fan_modes || [])]);
    showSupported('preset', c.presets && [...c.presets, ...(c.custom_presets || [])]);
    showSupported('swing', c.swing_modes);
    const wf = on && /^(COOL|DRY)$/.test(c.mode);
    const wfb = $('[data-k="preset"] [data-v="WindFree"]'); if (wfb) wfb.disabled = !wf && pre !== 'WindFree';
  }
  txt('#k-room', num(E.room)); txt('#k-hum', num(E.hum, 0)); txt('#k-out', num(E.out));
  txt('#k-pw', num(E.power, 0)); txt('#k-en', num(E.energy, 1));
  // maintenance
  const p = st[E.fPct]?.value;
  const ring = $('#ring');
  if (typeof p === 'number') { ring.style.setProperty('--p', Math.min(100, p)); ring.style.setProperty('--c', p >= 100 ? 'var(--bad)' : p >= 80 ? 'var(--warn)' : 'var(--blue)'); txt('#fpct', Math.round(p) + '%'); }
  txt('#fh', num(E.fH, 0)); txt('#fcap', num(E.fCap, 0));
  const w = st[E.fWarn]?.value;
  $('#fstat').innerHTML = w === true ? badge('bad', t('fClean')) : w === false ? badge('ok', t('fOk')) : '–';
  const er = st[E.err]?.value;
  $('#err').innerHTML = er === 0 ? badge('ok', t('noErr')) : typeof er === 'number' ? badge('bad', t('code', { c: er })) : '–';
  txt('#evi', num(E.evaIn)); txt('#evo', num(E.evaOut));
  $('#clean').classList.toggle('on', !!st[E.clean]?.value);
  const bus = st[E.bus]?.value;
  $('#bus').innerHTML = bus === true ? badge('ok', t('busOk')) : bus === false ? badge('warn', t('busQuiet')) : '–';
  const ws = st[E.wifi]?.value;
  $('#wifi').innerHTML = typeof ws === 'number' ? `${ws} dBm ${badge(ws > -65 ? 'ok' : ws > -75 ? 'warn' : 'bad', t(ws > -65 ? 'good' : ws > -75 ? 'fair' : 'weak'))}` : '–';
  txt('#up', fmtUptime(st[E.up]?.value));
  txt('#ip', st[E.ip]?.value ?? '–'); txt('#mac', st[E.mac]?.value ?? '–');
}

const LVL = { EW: /[EW]/, EWI: /[EWI]/ };
function addLog(raw) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const m = line.match(/\]\[([EWICDV])\]/);
  const now = new Date().toLocaleTimeString(LOCALE[lang], { hour12: false });
  logs.push({ t: line.startsWith('[') ? line : `[${now}] ${line}`, l: m ? m[1] : 'V' });
  if (logs.length > 600) logs.shift();
  saveLogs();
  if (!logPaused) renderLog(false);
}
function renderLog(all) {
  const box = $('#log'); if (!box) return;
  const ok = l => logLevel === 'ALL' || LVL[logLevel].test(l.l);
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const line = l => { const d = document.createElement('div'); d.className = 'l' + l.l; d.textContent = l.t; return d; };
  if (all) { box.textContent = ''; logs.filter(ok).forEach(l => box.appendChild(line(l))); }
  else { const l = logs[logs.length - 1]; if (ok(l)) box.appendChild(line(l)); while (box.childElementCount > 600) box.firstChild.remove(); }
  if (atEnd || all) box.scrollTop = box.scrollHeight;
}

// ---------- live connection ----------
let rt = 0, connOk = null;
function setConn(ok) {
  connOk = ok;
  $('#dot').classList.toggle('ok', !!ok);
  txt('#connt', ok == null ? t('connecting') : ok ? t('connected') : t('lost'));
}
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('state', e => { try { const d = JSON.parse(e.data); if (d.id) { const k = shortId(d.id); if (full[k] && full[k] !== d.id) return; full[k] = d.id; if (k === CLIMATE && d.id !== k) unitName = d.id.split('/')[1]; st[k] = { ...st[k], ...d }; clearTimeout(rt); rt = setTimeout(render, 50); } } catch (_) { } });
  es.addEventListener('log', e => addLog(e.data));
  es.addEventListener('ping', () => setConn(true));
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
}

shell(); connect();
