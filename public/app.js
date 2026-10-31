// Kartenwerkstatt – Frontend (MapLibre, kein Build-Schritt nötig)
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { sessionId: null, layers: new Map(), picked: null, config: {}, busy: false };

// ------------------------------------------------------------------ Karte
// Hell/Dunkel: OpenFreeMap-Vektorstile (ohne Key; CARTO-Kacheln brauchen inzwischen einen API-Key)
const BASEMAPS = {
  light: { style: 'https://tiles.openfreemap.org/styles/positron' },
  dark: { style: 'https://tiles.openfreemap.org/styles/dark' },
  osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© OpenStreetMap-Mitwirkende' },
};
const CREDITS = { light: 'Basiskarte © OpenFreeMap', dark: 'Basiskarte © OpenFreeMap', osm: '', none: '' };

const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } }] },
  center: [10, 51], zoom: 4.5, preserveDrawingBuffer: true, dragRotate: false, pitchWithRotate: false,
  maxCanvasSize: [8192, 8192], // Standard 4096 begrenzt die Exportauflösung
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.touchZoomRotate.disableRotation();

let mapReady = false;
const afterReady = [];
map.on('load', () => { mapReady = true; setBasemap('light'); afterReady.splice(0).forEach((f) => f()); });
const whenReady = (f) => (mapReady ? f() : afterReady.push(f));

let currentBasemap = 'light';
let basemapIds = { layers: [], sources: [] };
const styleCache = new Map();
async function setBasemap(key) {
  currentBasemap = key;
  for (const id of basemapIds.layers) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of basemapIds.sources) if (map.getSource(id)) map.removeSource(id);
  basemapIds = { layers: [], sources: [] };
  map.setPaintProperty('bg', 'background-color', '#ffffff');
  if (key === 'none') return;
  const b = BASEMAPS[key];
  // Basiskarte direkt über den Hintergrund legen, also unter alle Analyse-Ebenen
  const before = () => { const ls = map.getStyle().layers; return ls[ls.findIndex((l) => l.id === 'bg') + 1]?.id; };

  if (b.tiles) {
    map.addSource('basemap', { type: 'raster', tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: 19 });
    map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' }, before());
    basemapIds = { layers: ['basemap'], sources: ['basemap'] };
    return;
  }

  let style = styleCache.get(b.style);
  if (!style) {
    try { style = await (await fetch(b.style)).json(); } catch { $('#basemap').value = 'osm'; return setBasemap('osm'); }
    styleCache.set(b.style, style);
  }
  if (currentBasemap !== key) return; // inzwischen umgeschaltet
  if (style.glyphs) map.setGlyphs(style.glyphs);
  if (style.sprite) map.setSprite(style.sprite);
  const ids = { layers: [], sources: [] };
  for (const [id, src] of Object.entries(style.sources)) { map.addSource(`bm-${id}`, src); ids.sources.push(`bm-${id}`); }
  const beforeId = before();
  for (const l of style.layers) {
    // Hintergrund des Stils (Landfarbe) übernimmt die eigene bg-Ebene
    if (l.type === 'background') { if (l.paint?.['background-color']) map.setPaintProperty('bg', 'background-color', l.paint['background-color']); continue; }
    const def = { ...l, id: `bm-${l.id}` };
    if (l.source) def.source = `bm-${l.source}`;
    map.addLayer(def, beforeId);
    ids.layers.push(def.id);
  }
  basemapIds = ids;
}
$('#basemap').addEventListener('change', (e) => setBasemap(e.target.value));

// ------------------------------------------------------------------ Ebenen auf der Karte
function colorExpr(l) {
  const pairs = Object.entries(l.groupColors || {});
  if (l.groupBy && pairs.length) return ['match', ['get', 'subtype'], ...pairs.flat(), l.color];
  return l.color;
}

function ensureLayer(def) { if (!map.getLayer(def.id)) map.addLayer(def); }

function applyLayer(l) {
  const sid = `src-${l.id}`;
  const src = map.getSource(sid);
  if (src) src.setData(l.geojson); else map.addSource(sid, { type: 'geojson', data: l.geojson });
  ensureLayer({ id: `${l.id}-fill`, type: 'fill', source: sid, filter: ['==', '$type', 'Polygon'], paint: {} });
  ensureLayer({ id: `${l.id}-line`, type: 'line', source: sid, filter: ['any', ['==', '$type', 'Polygon'], ['==', '$type', 'LineString']], paint: {} });
  ensureLayer({ id: `${l.id}-circle`, type: 'circle', source: sid, filter: ['==', '$type', 'Point'], paint: {} });
  paintLayer(l);
  reorder();
}

function paintLayer(l) {
  const c = colorExpr(l);
  const vis = l.visible ? 'visible' : 'none';
  map.setPaintProperty(`${l.id}-fill`, 'fill-color', c);
  map.setPaintProperty(`${l.id}-fill`, 'fill-opacity', Number(l.fillOpacity));
  map.setPaintProperty(`${l.id}-line`, 'line-color', c);
  map.setPaintProperty(`${l.id}-line`, 'line-width', 1.6);
  map.setPaintProperty(`${l.id}-line`, 'line-opacity', 0.95);
  map.setPaintProperty(`${l.id}-circle`, 'circle-color', c);
  map.setPaintProperty(`${l.id}-circle`, 'circle-radius', ['interpolate', ['linear'], ['zoom'], 9, 2.5, 14, 5, 18, 8]);
  map.setPaintProperty(`${l.id}-circle`, 'circle-stroke-color', '#ffffff');
  map.setPaintProperty(`${l.id}-circle`, 'circle-stroke-width', 1.2);
  map.setPaintProperty(`${l.id}-circle`, 'circle-opacity', Math.max(0.2, Number(l.fillOpacity)));
  for (const k of ['fill', 'line', 'circle']) map.setLayoutProperty(`${l.id}-${k}`, 'visibility', vis);
}

function geomRank(l) {
  const t = l.geojson.features[0]?.geometry.type || 'Polygon';
  return /Point/.test(t) ? 2 : /Line/.test(t) ? 1 : 0;
}
function reorder() {
  const ordered = [...state.layers.values()].map((l, i) => ({ l, i })).sort((a, b) => geomRank(a.l) - geomRank(b.l) || a.i - b.i);
  for (const { l } of ordered) for (const k of ['fill', 'line', 'circle']) if (map.getLayer(`${l.id}-${k}`)) map.moveLayer(`${l.id}-${k}`);
}

function removeFromMap(id) {
  for (const k of ['fill', 'line', 'circle']) if (map.getLayer(`${id}-${k}`)) map.removeLayer(`${id}-${k}`);
  if (map.getSource(`src-${id}`)) map.removeSource(`src-${id}`);
}

function fitBbox(b) {
  if (!b) return;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 70, maxZoom: 17, duration: 900 });
}

// Klick: Popup auf Objekten, sonst Punkt markieren
const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px' });
let pickMarker = null;
map.on('click', (e) => {
  const ids = [...state.layers.keys()].flatMap((id) => ['circle', 'fill'].map((k) => `${id}-${k}`)).filter((i) => map.getLayer(i));
  const hit = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : [];
  if (hit.length) {
    const p = hit[0].properties;
    const rows = Object.entries(p).filter(([k, v]) => v !== '' && v != null && k !== 'osm_id' && k !== 'footprint')
      .map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>');
    popup.setLngLat(e.lngLat).setHTML(`<b>${esc(p.name || p.subtype || 'Objekt')}</b>${rows}`).addTo(map);
    return;
  }
  setPicked(e.lngLat.lat, e.lngLat.lng);
});

function setPicked(lat, lon) {
  state.picked = lat == null ? null : { lat, lon };
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  if (state.picked) pickMarker = new maplibregl.Marker({ color: '#dc2626' }).setLngLat([lon, lat]).addTo(map);
  $('#pick-chip').hidden = !state.picked;
  if (state.picked) $('#pick-text').textContent = `Punkt ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
$('#pick-clear').addEventListener('click', () => setPicked(null));

// ------------------------------------------------------------------ Ebenen-Panel
function renderLayers() {
  const box = $('#layers');
  $('#layers-empty').hidden = state.layers.size > 0;
  box.innerHTML = '';
  for (const l of [...state.layers.values()].reverse()) {
    const s = l.summary || {};
    const area = s.total_area_km2 != null ? ` · ${s.total_area_km2.toLocaleString('de-DE')} km²` : '';
    const grouped = l.groupBy && Object.keys(l.groupColors || {}).length;
    const subs = grouped
      ? `<div class="subs">${Object.entries(l.groupColors).map(([k, c]) =>
        `<div class="s"><input type="color" value="${c}" data-act="gcolor" data-key="${esc(k)}"><span>${esc(k)}</span><span class="n">${(s.by_subtype?.[k] ?? '')}</span></div>`).join('')}</div>`
      : '';
    const div = document.createElement('div');
    div.className = 'layer';
    div.dataset.id = l.id;
    div.innerHTML = `
      <div class="top">
        <input type="checkbox" data-act="vis" ${l.visible ? 'checked' : ''} title="Sichtbar">
        ${grouped ? '' : `<input type="color" value="${l.color}" data-act="color" title="Farbe">`}
        <div class="name">${esc(l.name)}</div>
      </div>
      <div class="meta">${s.features ?? l.geojson.features.length} Objekte${area}</div>
      ${subs}
      <div class="op">Deckkraft <input type="range" min="0" max="1" step="0.05" value="${l.fillOpacity}" data-act="opacity"></div>
      <div class="acts"><button data-act="table">Tabelle</button><button data-act="zoom">Zoom</button><button data-act="del" class="del">Entfernen</button></div>`;
    box.appendChild(div);
  }
}

function syncServer(id, patch) {
  if (!state.sessionId) return;
  fetch(`/api/session/${state.sessionId}/layers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
}

$('#layers').addEventListener('input', (e) => {
  const el = e.target;
  const id = el.closest('.layer')?.dataset.id;
  const l = state.layers.get(id);
  if (!l) return;
  const act = el.dataset.act;
  if (act === 'color') { l.color = el.value; syncServer(id, { color: l.color }); }
  else if (act === 'gcolor') { l.groupColors[el.dataset.key] = el.value; syncServer(id, { group_colors: { [el.dataset.key]: el.value } }); }
  else if (act === 'opacity') { l.fillOpacity = Number(el.value); syncServer(id, { fill_opacity: l.fillOpacity }); }
  else if (act === 'vis') { l.visible = el.checked; syncServer(id, { visible: l.visible }); }
  else return;
  paintLayer(l);
});
$('#layers').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.layer').dataset.id;
  const l = state.layers.get(id);
  if (btn.dataset.act === 'del') {
    removeFromMap(id); state.layers.delete(id); renderLayers();
    fetch(`/api/session/${state.sessionId}/layers/${id}`, { method: 'DELETE' }).catch(() => {});
  } else if (btn.dataset.act === 'zoom') {
    if (l.geojson.features.length) fitBbox(bboxOf(l.geojson));
  } else if (btn.dataset.act === 'table') showTable(l);
});

function bboxOf(fc) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  fc.features.forEach((f) => walk(f.geometry.coordinates));
  return [w, s, e, n];
}

// ------------------------------------------------------------------ Tabelle
function showTable(l) {
  const feats = l.geojson.features;
  const cols = [...new Set(feats.flatMap((f) => Object.keys(f.properties || {})))].filter((k) => k !== 'footprint');
  $('#table-title').textContent = l.name;
  $('#table-info').textContent = `${feats.length} Objekte` + (feats.length > 1000 ? ' (Anzeige: erste 1000)' : '');
  const rows = feats.slice(0, 1000).map((f) => `<tr>${cols.map((c) => `<td>${esc(f.properties?.[c])}</td>`).join('')}</tr>`).join('');
  $('#table-body').innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  $('#table-csv').onclick = () => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.map(q).join(','), ...feats.map((f) => cols.map((c) => q(f.properties?.[c])).join(','))].join('\n');
    download(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }), `${l.name.replace(/[^\w\-]+/g, '_')}.csv`);
  };
  $('#table-dialog').showModal();
}
$('#table-close').addEventListener('click', () => $('#table-dialog').close());

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ Chat
const messages = $('#messages');
function mdLite(t) {
  const lines = esc(t).split('\n');
  let html = ''; let inList = false;
  for (const ln of lines) {
    const li = /^\s*[-*•]\s+(.*)/.exec(ln);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += ln.trim() ? `<div>${ln}</div>` : '<div style="height:6px"></div>';
  }
  if (inList) html += '</ul>';
  return html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}
function addMsg(kind, text, raw = false) {
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  d.innerHTML = raw ? text : (kind === 'bot' ? mdLite(text) : esc(text));
  messages.appendChild(d);
  messages.scrollTop = messages.scrollHeight;
  return d;
}

const EXAMPLES = [
  '15-Minuten-Fußweg um Deventer, Niederlande',
  'Zeige Grünflächen innerhalb der Isochrone',
  'Haltestellen im 1-km-Radius um den markierten Punkt',
  'Schulen im Umkreis von 1 km',
];
$('#chips').innerHTML = EXAMPLES.map((t) => `<button type="button">${esc(t)}</button>`).join('');
$('#chips').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { $('#chat-input').value = e.target.textContent; $('#chat-input').focus(); } });

async function send(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true; $('#send').disabled = true;
  const full = state.picked ? `[Markierter Punkt: ${state.picked.lat.toFixed(6)}, ${state.picked.lon.toFixed(6)}]\n${text}` : text;
  addMsg('user', text);
  const wait = addMsg('bot busy', 'Analysiere');
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: state.sessionId, message: full }) });
    const data = await r.json();
    wait.remove();
    if (!r.ok) throw new Error(data.error || r.statusText);
    for (const id of data.remove || []) { removeFromMap(id); state.layers.delete(id); }
    whenReady(() => {
      for (const l of data.upsert || []) { state.layers.set(l.id, l); applyLayer(l); }
      reorder();
      if (data.view) fitBbox(data.view);
    });
    renderLayers();
    addMsg('bot', data.reply || 'Fertig.');
  } catch (err) {
    wait.remove();
    addMsg('err', String(err.message || err));
  } finally {
    state.busy = false; $('#send').disabled = false; $('#chat-input').focus();
  }
}
$('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#chat-input').value; $('#chat-input').value = ''; send(t); });
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); } });

// ------------------------------------------------------------------ Tabs
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  updateFrame(name === 'export' || name === 'style');
  if (name === 'style') updatePoiList();
}
$('#tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

// ------------------------------------------------------------------ Export
const PAGES = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };
function pageInfo() {
  const [long, short] = PAGES[$('#ex-format').value];
  const landscape = $('#ex-orient').value === 'landscape';
  return { aspect: landscape ? long / short : short / long, widthMm: landscape ? long : short, label: `${$('#ex-format').value} ${landscape ? 'quer' : 'hoch'}` };
}
function frameRect() {
  const W = map.getContainer().clientWidth; const H = map.getContainer().clientHeight;
  const { aspect } = pageInfo();
  let w = W * 0.9; let h = w / aspect;
  if (h > H * 0.9) { h = H * 0.9; w = h * aspect; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
function updateFrame(show) {
  const f = $('#frame');
  f.hidden = !show;
  if (!show) return;
  const r = frameRect();
  Object.assign(f.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
}
['#ex-format', '#ex-orient'].forEach((s) => $(s).addEventListener('change', () => updateFrame(true)));
window.addEventListener('resize', () => updateFrame(!$('#frame').hidden));
// Rahmen nur ausblenden; der Export nutzt denselben Ausschnitt. Tabwechsel oder Formatwahl zeigen ihn wieder.
$('#frame-close').addEventListener('click', () => updateFrame(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#frame').hidden && !document.querySelector('dialog[open]')) updateFrame(false); });

// Die Karte für den Export kurz mit höherer Pixeldichte rendern, damit der Ausschnitt targetWidth Pixel breit wird
// (Bildschirmauflösung reicht für A3/A2 nicht). Vektorkarten werden dabei scharf, Rasterkacheln (OSM) nur hochskaliert.
const MAX_CANVAS = 8192; // wie maxCanvasSize der Karte
function grabMap(targetWidth) {
  const el = map.getContainer();
  const ratio = Math.min(MAX_CANVAS / Math.max(el.clientWidth, el.clientHeight), Math.max(devicePixelRatio, targetWidth / frameRect().w));
  return new Promise((resolve) => {
    map.once('idle', () => {
      const src = map.getCanvas();
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      map.setPixelRatio(devicePixelRatio);
      resolve(c);
    });
    map.setPixelRatio(ratio);
    map.triggerRepaint();
  });
}

function niceLength(m) {
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [5, 2, 1]) if (f * p <= m) return f * p;
  return p;
}

const EXPORT_DPI = 300;
// Nur den Exportausschnitt der Karte als Bild, ohne Beigaben
async function grabFrame(targetWidth) {
  const src = await grabMap(targetWidth);
  const r = frameRect();
  const k = src.width / map.getContainer().clientWidth;
  const out = document.createElement('canvas');
  out.width = Math.round(r.w * k); out.height = Math.round(r.h * k);
  out.getContext('2d').drawImage(src, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, out.width, out.height);
  return out;
}

async function composeExport(targetWidth = Math.round((pageInfo().widthMm / 25.4) * EXPORT_DPI)) {
  const out = await grabFrame(targetWidth);
  const g = out.getContext('2d');

  const u = out.width / 1200;
  const font = (px, w = 400) => `${w} ${Math.round(px * u)}px ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif`;
  const box = (x, y, w, h) => { g.fillStyle = 'rgba(255,255,255,0.92)'; g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = u; g.beginPath(); g.roundRect(x, y, w, h, 6 * u); g.fill(); g.stroke(); };
  const pad = 16 * u;

  // Titel
  const title = $('#ex-title').value.trim();
  if (title) {
    g.font = font(26, 700);
    const w = g.measureText(title).width + 2 * pad;
    box(pad, pad, w, 50 * u);
    g.fillStyle = '#111827'; g.textBaseline = 'middle'; g.fillText(title, pad * 2, pad + 25 * u);
  }

  // Maßstab
  const lat = map.getCenter().lat;
  const mppCss = (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
  const mPerOutPx = (mppCss * r.w) / out.width;
  const info = pageInfo();
  const denom = Math.round(((mppCss * r.w * 1000) / info.widthMm) / 100) * 100;

  if ($('#ex-scale').checked) {
    const len = niceLength(out.width * 0.2 * mPerOutPx);
    const px = len / mPerOutPx;
    const bw = px + 2 * pad; const bh = 66 * u;
    const bx = out.width - bw - pad; const by = out.height - bh - pad;
    box(bx, by, bw, bh);
    const x0 = bx + pad; const y0 = by + 14 * u; const seg = px / 4;
    for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#fff' : '#111827'; g.fillRect(x0 + i * seg, y0, seg, 9 * u); }
    g.strokeStyle = '#111827'; g.lineWidth = u; g.strokeRect(x0, y0, px, 9 * u);
    g.fillStyle = '#111827'; g.font = font(13); g.textBaseline = 'top';
    const lab = (m) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);
    g.textAlign = 'left'; g.fillText('0', x0, y0 + 13 * u);
    g.textAlign = 'right'; g.fillText(lab(len), x0 + px, y0 + 13 * u);
    g.textAlign = 'left'; g.font = font(12); g.fillStyle = '#4b5563';
    g.fillText(`Maßstab ca. 1:${denom.toLocaleString('de-DE')} (${info.label})`, x0, y0 + 34 * u);
  }

  // Nordpfeil
  if ($('#ex-north').checked) {
    const cx = out.width - pad - 22 * u; const cy = pad + 42 * u;
    g.fillStyle = 'rgba(255,255,255,0.92)'; g.beginPath(); g.arc(cx, cy, 30 * u, 0, 7); g.fill();
    g.fillStyle = '#111827'; g.beginPath(); g.moveTo(cx, cy - 22 * u); g.lineTo(cx + 10 * u, cy + 10 * u); g.lineTo(cx, cy + 4 * u); g.lineTo(cx - 10 * u, cy + 10 * u); g.closePath(); g.fill();
    g.font = font(14, 700); g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('N', cx, cy + 25 * u);
  }

  // Legende
  if ($('#ex-legend').checked) {
    const items = [];
    for (const l of state.layers.values()) {
      if (!l.visible || !l.geojson.features.length) continue;
      const isPoint = geomRank(l) === 2;
      items.push({ head: l.name });
      if (l.groupBy && Object.keys(l.groupColors || {}).length) {
        for (const [k, c] of Object.entries(l.groupColors)) items.push({ label: `${k}${l.summary?.by_subtype?.[k] != null ? ` (${l.summary.by_subtype[k]})` : ''}`, color: c, point: isPoint, op: l.fillOpacity });
      } else items.push({ label: `${l.geojson.features.length} Objekte`, color: l.color, point: isPoint, op: l.fillOpacity });
    }
    if (items.length) {
      g.font = font(13);
      const rowH = 22 * u;
      let maxW = 0;
      for (const it of items) { g.font = font(it.head ? 14 : 13, it.head ? 700 : 400); maxW = Math.max(maxW, g.measureText(it.head || it.label).width + (it.head ? 0 : 30 * u)); }
      const bw = maxW + 2 * pad; const bh = items.length * rowH + 2 * pad - 4 * u;
      const bx = pad; const by = out.height - bh - pad;
      box(bx, by, bw, bh);
      let y = by + pad;
      g.textBaseline = 'middle'; g.textAlign = 'left';
      for (const it of items) {
        if (it.head) { g.font = font(14, 700); g.fillStyle = '#111827'; g.fillText(it.head, bx + pad, y + rowH / 2); }
        else {
          g.fillStyle = it.color; g.globalAlpha = it.point ? 1 : Math.min(1, it.op + 0.25);
          if (it.point) { g.beginPath(); g.arc(bx + pad + 7 * u, y + rowH / 2, 6 * u, 0, 7); g.fill(); }
          else { g.fillRect(bx + pad, y + 4 * u, 16 * u, rowH - 8 * u); }
          g.globalAlpha = 1; g.font = font(13); g.fillStyle = '#1f2937'; g.fillText(it.label, bx + pad + 26 * u, y + rowH / 2);
        }
        y += rowH;
      }
    }
  }

  // Quellen
  if ($('#ex-credit').checked) {
    const parts = ['Daten © OpenStreetMap-Mitwirkende', 'Routing: Valhalla (FOSSGIS)', CREDITS[currentBasemap]].filter(Boolean).join(' · ');
    g.font = font(11); g.textAlign = 'right'; g.textBaseline = 'alphabetic';
    const w = g.measureText(parts).width + 12 * u;
    g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(out.width - w, out.height - 16 * u, w, 16 * u);
    g.fillStyle = '#374151'; g.fillText(parts, out.width - 6 * u, out.height - 4 * u);
  }
  return out;
}

const toBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));

$('#ex-preview').addEventListener('click', async () => {
  const c = await composeExport();
  const img = $('#ex-img'); img.src = c.toDataURL('image/png'); img.hidden = false;
});
$('#ex-download').addEventListener('click', async () => {
  const btn = $('#ex-download'); btn.disabled = true;
  const c = await composeExport().finally(() => { btn.disabled = false; });
  download(await toBlob(c), `karte-${$('#ex-format').value}.png`);
});

// ------------------------------------------------------------------ Stylisieren
const PRESETS = {
  brief: ['Planungs-Brief (hell, sachlich)', 'a clean municipal planning policy brief aesthetic with a soft cool-gray base map, even tones for water and land, crisp thin outlines and a refined sans-serif typeface'],
  dark: ['Dunkel mit Neon', 'a dark theme with a near-black base map and vibrant glowing neon colours for the data layers, subtle glow, high contrast, modern look'],
  bluehour: ['Blue Hour (filmisch)', 'cinematic blue-hour cartography with luminous contours, a deep blue base, warm glowing highlights and dynamic icons, premium and atmospheric'],
  atlas: ['Historischer Atlas', 'a warm light cartographic style like an old atlas plate, cream paper texture, hand-inked linework and muted earthy colours'],
  render: ['Gerenderter Lageplan', 'a Photoshop-rendered site plan with subtle textures, soft shadows, rendered trees and clean graphic symbols'],
};
$('#st-preset').innerHTML = Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('');
$('#st-preserve').value = 'Preserve the exact geometry, positions, proportions, scale, numbering, symbology and all data shown in the attached map. Do not add, remove, move or reshape any feature, and do not invent labels or numbers.';
$('#st-layout').value = 'Keep the title at the top left, the legend at the bottom left, the scale bar at the bottom right and the north arrow at the top right. Keep all legend entries and their order.';
$('#st-style').value = PRESETS.brief[1];
$('#st-preset').addEventListener('change', (e) => { $('#st-style').value = PRESETS[e.target.value][1]; });

function fillData() {
  const lines = [];
  for (const l of state.layers.values()) {
    if (!l.visible) continue;
    if (l.groupBy && Object.keys(l.groupColors || {}).length) lines.push(`- ${l.name}: categories ${Object.entries(l.groupColors).map(([k, c]) => `${k} (${c})`).join(', ')}`);
    else lines.push(`- ${l.name} (${l.color})`);
  }
  $('#st-data').value = lines.length ? `The map shows the following layers. Keep their data and symbology:\n${lines.join('\n')}` : 'Keep all map data and the legend as shown.';
}
$('#st-fill').addEventListener('click', fillData);

const composePrompt = () => [
  `PRESERVE: ${$('#st-preserve').value.trim()}`,
  `STYLE: Re-render this as a professional, legible GIS map in ${$('#st-style').value.trim()}.`,
  `DATA: ${$('#st-data').value.trim()}`,
  `LAYOUT: ${$('#st-layout').value.trim()}`,
].join('\n\n');

$('#st-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(composePrompt());
  $('#st-status').textContent = 'Prompt kopiert.';
});

function downscale(c, max = 2048) {
  const k = Math.min(1, max / Math.max(c.width, c.height));
  if (k === 1) return c;
  const o = document.createElement('canvas'); o.width = Math.round(c.width * k); o.height = Math.round(c.height * k);
  o.getContext('2d').drawImage(c, 0, 0, o.width, o.height); return o;
}

// Gemini erzeugt nur feste Seitenverhältnisse. Damit die Karte nicht verzerrt wird (Maßstab!), den Ausschnitt
// mit Rand auf das nächstliegende Format bringen und das Ergebnis danach wieder auf den Ausschnitt zuschneiden.
// Die Formate sind nur Näherungen, deshalb mit den Pixelmaßen rechnen, die Gemini tatsächlich liefert (z. B. „4:3“ = 1184 × 864).
const IMAGE_RATIOS = { '1:1': [1024, 1024], '2:3': [832, 1248], '3:2': [1248, 832], '3:4': [864, 1184], '4:3': [1184, 864], '4:5': [896, 1152], '5:4': [1152, 896], '9:16': [768, 1344], '16:9': [1344, 768], '21:9': [1536, 672] };
function padToRatio(c) {
  const r = c.width / c.height;
  const ratio = Object.entries(IMAGE_RATIOS).map(([name, [w, h]]) => ({ name, value: w / h }))
    .reduce((best, x) => (Math.abs(Math.log(x.value / r)) < Math.abs(Math.log(best.value / r)) ? x : best));
  const W = Math.round(Math.max(c.width, c.height * ratio.value));
  const H = Math.round(Math.max(c.height, c.width / ratio.value));
  const o = document.createElement('canvas'); o.width = W; o.height = H;
  const g = o.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.drawImage(c, (W - c.width) / 2, (H - c.height) / 2);
  // Lage des Ausschnitts relativ zum aufgefüllten Bild, zum späteren Zuschneiden
  const crop = { x: (W - c.width) / 2 / W, y: (H - c.height) / 2 / H, w: c.width / W, h: c.height / H };
  return { canvas: o, ratio: ratio.name, crop, aspect: r };
}
function loadImage(src) {
  return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Ergebnisbild nicht lesbar.')); i.src = src; });
}
// Ausschnitt aus dem Ergebnis schneiden und auf das exakte Seitenverhältnis bringen, falls das Modell leicht abweicht
async function cropResult(dataUrl, crop, aspect) {
  const img = await loadImage(dataUrl);
  const sx = img.naturalWidth * crop.x; const sy = img.naturalHeight * crop.y;
  const sw = img.naturalWidth * crop.w; const sh = img.naturalHeight * crop.h;
  const o = document.createElement('canvas');
  o.width = Math.round(sw); o.height = Math.round(sw / aspect);
  o.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, o.width, o.height);
  return o;
}

// Bild an das Bildmodell schicken (mit Rand auf ein Gemini-Format gebracht) und auf den Ausschnitt zurückschneiden
async function stylizeCanvas(canvas, prompt, references = [], resolution) {
  const p = padToRatio(canvas);
  if (p.crop.w < 0.995 || p.crop.h < 0.995) prompt += '\n\nThe input has plain white margins around the map. Keep the map exactly in place and at the same size, and leave the margins plain white.';
  const r = await fetch('/api/stylize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: p.canvas.toDataURL('image/png'), prompt, aspect_ratio: p.ratio, references, resolution }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return { canvas: await cropResult(data.image, p.crop, p.aspect), model: data.model };
}

function showResult(canvas, filename) {
  const image = canvas.toDataURL('image/png');
  $('#st-img').src = image; $('#st-img').hidden = false;
  const a = $('#st-download'); a.href = image; a.download = filename; a.hidden = false;
}

$('#st-run').addEventListener('click', async () => {
  const status = $('#st-status'); const btn = $('#st-run');
  if (!$('#st-data').value.trim()) fillData();
  btn.disabled = true; status.textContent = 'Rendere Karte … das kann eine halbe Minute dauern.';
  try {
    const res = await stylizeCanvas(downscale(await composeExport(2048)), composePrompt());
    showResult(res.canvas, 'karte-stylisiert.png');
    status.textContent = `Fertig (${res.model}). Beschriftungen und Nummern bitte gegen die Originalkarte prüfen.`;
  } catch (err) {
    status.textContent = `Fehler: ${err.message || err}`;
  } finally { btn.disabled = false; }
});

// ------------------------------------------------------------------ Illustrierte Stadtkarte
// Das Modell zeichnet nur (ohne Text). Nummern, Legende und Titel setzt die App danach, weil Bildmodelle Namen verfälschen.
const ILLU_PRESETS = {
  watercolor: ['Aquarell & Tusche', 'a hand-drawn watercolour and ink illustration on warm off-white paper, loose ink linework, soft washes of colour, charming and detailed like a travel sketchbook'],
  vintage: ['Vintage-Stadtplan', 'a vintage illustrated tourist map from the 1950s, muted retro colours, screen-printed texture, bold simple shapes'],
  iso: ['Isometrisch verspielt', 'a playful illustrated city map with small isometric 3D buildings, bright friendly colours and clean vector shapes, like a modern city guide'],
  line: ['Feine Linienzeichnung', 'an elegant fine-liner pen drawing in black ink on white paper with a single warm accent colour, minimal and architectural'],
};
$('#il-preset').innerHTML = Object.entries(ILLU_PRESETS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('');
$('#il-style').value = ILLU_PRESETS.watercolor[1];
$('#il-preset').addEventListener('change', (e) => { $('#il-style').value = ILLU_PRESETS[e.target.value][1]; });

const MAX_POIS = 30;
// Benannte Punkte aus sichtbaren Ebenen im Ausschnitt, Lage relativ zum Ausschnitt (0..1), in Lesereihenfolge nummeriert
// Grundriss eines Orts in Ausschnitt-Koordinaten (0..1): aus OSM (properties.footprint) oder, für Gebäude-Typen,
// aus dem Gebäude der Vektorkarte, in dem der Punkt liegt. So weiß Gemini, wo und wie groß das Wahrzeichen ist.
function poiFootprint(f, pt, r) {
  let geom = f.properties.footprint;
  if (typeof geom === 'string') { try { geom = JSON.parse(geom); } catch { geom = null; } }
  if (!geom && REF_TYPES.includes(f.properties.subtype)) {
    const ids = basemapIds.layers.filter((id) => map.getLayer(id)?.sourceLayer === 'building' && map.getLayoutProperty(id, 'visibility') !== 'none');
    const hit = ids.length ? map.queryRenderedFeatures([[pt.x - 2, pt.y - 2], [pt.x + 2, pt.y + 2]], { layers: ids }) : [];
    geom = hit.find((h) => /Polygon/.test(h.geometry.type))?.geometry || null;
  }
  if (!geom) return null;
  let polys = (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates)
    .map((rings) => rings.map((ring) => ring.map((c) => { const q = map.project(c); return [(q.x - r.x) / r.w, (q.y - r.y) / r.h]; })));
  // Die Vektorkarte fasst oft viele Häuser zu einem Multipolygon zusammen: nur das Gebäude nehmen, in dem der Punkt liegt.
  if (!f.properties.footprint) {
    const px = (pt.x - r.x) / r.w; const py = (pt.y - r.y) / r.h;
    polys = polys.filter((rings) => insideRing(px, py, rings[0])).slice(0, 1);
  }
  if (!polys.length) return null;
  const xs = polys.flat(2).map((c) => c[0]); const ys = polys.flat(2).map((c) => c[1]);
  const fp = { polys, x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
  // Unplausibel große Umrisse (Gelände, Häuserblöcke) helfen Gemini nicht weiter
  return fp.x2 - fp.x1 > 0.3 || fp.y2 - fp.y1 > 0.3 ? null : fp;
}

function insideRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function collectPois() {
  const r = frameRect(); const seen = new Set(); const pois = [];
  for (const l of state.layers.values()) {
    if (!l.visible) continue;
    for (const f of l.geojson.features) {
      const name = String(f.properties?.name || '').trim();
      if (f.geometry?.type !== 'Point' || !name || f.properties.subtype === 'Standort' || seen.has(name.toLowerCase())) continue;
      const pt = map.project(f.geometry.coordinates);
      const fx = (pt.x - r.x) / r.w; const fy = (pt.y - r.y) / r.h;
      if (fx < 0.03 || fx > 0.97 || fy < 0.03 || fy > 0.97) continue;
      seen.add(name.toLowerCase());
      pois.push({ name, type: f.properties.subtype || '', wikidata: f.properties.wikidata || null, fx, fy, fp: poiFootprint(f, pt, r) });
    }
  }
  pois.sort((a, b) => Math.floor(a.fy * 6) - Math.floor(b.fy * 6) || a.fx - b.fx);
  return pois.slice(0, MAX_POIS).map((p, i) => ({ ...p, n: i + 1 }));
}

// Ort für den Prompt (damit Gemini die echte örtliche Bauweise kennt), vorbelegt aus dem Standort des Chats
function suggestPlace() {
  for (const l of state.layers.values()) {
    const f = l.geojson.features.find((x) => x.properties?.subtype === 'Standort' && x.properties.name);
    if (f) return f.properties.name;
  }
  return '';
}

function updatePoiList() {
  if ($('#st-illu').hidden) return;
  if (!$('#il-place').value.trim()) $('#il-place').value = suggestPlace();
  const pois = collectPois();
  $('#il-pois').innerHTML = pois.length
    ? `<strong>${pois.length} Orte im Ausschnitt</strong>${pois.length === MAX_POIS ? ' <span class="muted">(max.)</span>' : ''}<ol>${pois.map((p) => `<li>${esc(p.name)}${p.type ? ` <span class="muted">· ${esc(p.type)}</span>` : ''}${p.wikidata && REF_TYPES.includes(p.type) ? ' <span class="muted" title="Wikidata-Eintrag vorhanden">· Wikidata</span>' : ''}</li>`).join('')}</ol>`
    : '<span class="muted">Keine benannten Punkte im Ausschnitt. Frag im Chat z. B. nach „Sehenswürdigkeiten in der Altstadt“, dann werden sie hier zu Zeichnungen.</span>';
}
map.on('moveend', updatePoiList);
['#ex-format', '#ex-orient'].forEach((s) => $(s).addEventListener('change', updatePoiList));

$('#st-mode').addEventListener('click', (e) => {
  const mode = e.target.dataset.mode; if (!mode) return;
  $('#st-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.target));
  $('#st-restyle').hidden = mode !== 'restyle'; $('#st-illu').hidden = mode !== 'illu';
  updatePoiList();
});

// Ausschnitt der Vektor-Basiskarte rendern, nur mit den Ebenen, für die keep(layer) gilt (alle anderen kurz ausgeblendet,
// optional mit geänderten Textfarben). Ist gerade keine Vektorkarte aktiv, wird kurz auf „Hell“ umgeschaltet.
async function grabVectorFrame(targetWidth, keep, textPaint = {}) {
  const prev = currentBasemap; const hidden = []; const painted = [];
  try {
    if (!BASEMAPS[prev]?.style) await setBasemap('light');
    const appIds = [...state.layers.keys()].flatMap((id) => ['fill', 'line', 'circle'].map((k) => `${id}-${k}`));
    for (const id of ['bg', ...basemapIds.layers, ...appIds]) {
      const l = map.getLayer(id);
      if (!l) continue;
      if (!keep(l)) {
        if (map.getLayoutProperty(id, 'visibility') !== 'none') { map.setLayoutProperty(id, 'visibility', 'none'); hidden.push(id); }
      } else if (l.type === 'symbol') {
        for (const [k, v] of Object.entries(textPaint)) { painted.push([id, k, map.getPaintProperty(id, k)]); map.setPaintProperty(id, k, v); }
      }
    }
    return await grabFrame(targetWidth);
  } finally {
    for (const [id, k, v] of painted) if (map.getLayer(id)) map.setPaintProperty(id, k, v);
    for (const id of hidden) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
    if (currentBasemap !== prev) await setBasemap(prev);
  }
}

// Zeichenvorlage: Vektor-Basiskarte ohne Beschriftungen (außer auf Wunsch Straßen-/Gewässernamen für Gemini),
// ohne Analyse-Ebenen, POIs als rote Punkte
async function renderTemplate(pois, withNames = false, dots = true) {
  const c = downscale(await grabVectorFrame(2048, (l) => l.id === 'bg' || (l.id.startsWith('bm-') && (l.type !== 'symbol' || (withNames && isNameLayer(l))))));
  const g = c.getContext('2d'); const rad = c.width * 0.005;
  // Grundrisse der Wahrzeichen hervorheben (sandfarben mit brauner Kontur): echte Lage, Größe und Ausrichtung
  for (const p of pois.filter((x) => x.fp)) {
    g.beginPath();
    for (const rings of p.fp.polys) for (const ring of rings) ring.forEach(([x, y], i) => (i ? g.lineTo(x * c.width, y * c.height) : g.moveTo(x * c.width, y * c.height)));
    g.fillStyle = '#d9b48f'; g.fill('evenodd'); g.lineWidth = Math.max(1.5, c.width / 900); g.strokeStyle = '#7a4a2a'; g.stroke();
  }
  for (const p of dots ? pois.filter((x) => !x.fp) : []) {
    g.beginPath(); g.arc(p.fx * c.width, p.fy * c.height, rad, 0, 7);
    g.fillStyle = '#e11d48'; g.fill(); g.lineWidth = rad * 0.35; g.strokeStyle = '#ffffff'; g.stroke();
  }
  return c;
}

// Straßen- und Gewässernamen aus der Vektorkarte, deckungsgleich zum Ausschnitt, auf transparentem Grund.
// Sie kommen nachträglich über die Zeichnung, weil Bildmodelle Namen verfälschen.
const isNameLayer = (l) => l.type === 'symbol' && l.id.startsWith('bm-') && !/shield/.test(l.id)
  && ['transportation_name', 'water_name', 'waterway'].includes(l.sourceLayer);
function renderNameLabels(width) {
  return grabVectorFrame(width, isNameLayer, { 'text-color': '#4a2f1a', 'text-halo-color': 'rgba(251,246,236,0.9)', 'text-halo-width': 1.6 });
}

// Gebäude-Typen, für die ein Referenzfoto hilft (Statuen, Gedenktafeln usw. nicht), in Reihenfolge der Wichtigkeit
const REF_TYPES = ['Kirche/Gotteshaus', 'Burg/Schloss', 'Stadttor', 'Sehenswürdigkeit', 'Museum', 'Theater', 'Windmühle', 'Leuchtturm', 'Ruine'];

// Wahrzeichen mit Wikidata-Foto holen, höchstens so viele, wie das Bildmodell neben der Karte annimmt
async function loadReferences(pois) {
  const max = Math.max(0, (state.config.maxReferences || 0) - 1);
  const cands = pois.filter((p) => p.wikidata && REF_TYPES.includes(p.type))
    .sort((a, b) => REF_TYPES.indexOf(a.type) - REF_TYPES.indexOf(b.type) || a.n - b.n);
  if (!max || !cands.length) return [];
  const r = await fetch('/api/references', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qids: cands.map((p) => p.wikidata) }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  // Ein Foto pro Wikidata-Eintrag (z. B. Kirche und Turm können denselben haben)
  const used = new Set();
  return cands.filter((p) => data.references[p.wikidata] && !used.has(p.wikidata) && used.add(p.wikidata))
    .slice(0, max).map((p, i) => ({ poi: p, index: i + 2, ...data.references[p.wikidata] }));
}

// Zwei Beschriftungsarten:
//  - text: false → Gemini zeichnet ohne Text, die App setzt Nummern, Legende und Straßennamen danach exakt darüber.
//  - text: true  → „aus einem Guss“: Straßennamen, Nummern, Titel und Legende stehen schon in der Vorlage,
//    Gemini zeichnet sie im Kartenstil nach (schöner, aber Schreibfehler möglich).
// Im Modus ohne Text stehen die POI-Namen bewusst nicht im Prompt, sonst schreibt das Modell sie ins Bild.
function composeIlluPrompt(pois, refs = [], { text = false, names = false, panel = false, mapFrac = 1, place = '', numbered = false } = {}) {
  const where = (p) => `${Math.round(p.fx * mapFrac * 100)}% from the left, ${Math.round(p.fy * 100)}% from the top`;
  const refOf = new Map(refs.map((r) => [r.poi, r]));
  const parts = [
    text
      ? 'Important: the only text allowed in the image is the text that is already written in the template, copied letter by letter. Do not add, translate or invent any words.'
      : 'Important: the image must contain no text at all.',
    `Turn this ${panel ? 'map sheet' : 'street map template'} into a beautiful illustrated city map in the style of ${$('#il-style').value.trim()}.`,
    'Keep the street network, rivers, water, parks and the overall shape of the city exactly as in the template, at the same positions and scale, so the map stays geographically recognisable. Draw main streets wider than side streets, built-up blocks as small illustrated houses and roofs, trees in parks and gentle texture on water.',
  ];
  if (place) parts.push(`This map shows ${place}. Draw the houses, roofs and landmarks in the authentic local architecture of this place as it really looks (typical building types, gables, roof shapes, materials and colours), using your knowledge of the place. Do not fall back on a generic or European style unless that is how this place really looks.${refs.length ? ' Landmarks that have a reference photo must follow their photo, even if their style differs from the surroundings.' : ''}`);
  if (panel) parts.push('The template is a complete map sheet: the map on the left and a legend panel on the right. Redraw the panel as a matching decorative cartouche on paper, at the same position and size, with the same title and the same numbered list of places in the same order.');
  if (refs.length) parts.push(`Image 1 is the template. Images 2 to ${refs.length + 1} are reference photos of real landmarks on this map. Use each photo only so that the small illustration of that landmark resembles the real building (silhouette, towers, roof shapes, materials, colours). Do not paste the photos, their perspective or their backgrounds into the map, and draw everything in the illustration style of the map.`);
  const pct = (v, f = 1) => Math.round(v * f * 100);
  const fpText = (p) => `standing exactly on the highlighted footprint from ${pct(p.fp.x1, mapFrac)}% to ${pct(p.fp.x2, mapFrac)}% from the left and ${pct(p.fp.y1)}% to ${pct(p.fp.y2)}% from the top`;
  const listing = pois.map((p) => `- ${numbered ? `number ${p.n}: ` : ''}${p.type || 'point of interest'} ${p.fp ? fpText(p) : `at ${where(p)}`}${refOf.has(p) ? ` (looks like the building in image ${refOf.get(p).index})` : ''}`).join('\n');
  if (pois.some((p) => p.fp)) parts.push('Landmark buildings are marked in the template as highlighted footprints (sand-coloured fill with a brown outline) at their exact real position, size and orientation. Draw each landmark as an illustrated building standing exactly on its footprint and covering it, with the same outline and orientation. Do not move landmarks, do not make them much bigger than their footprint, and do not draw any landmark anywhere else. After drawing, no sand-coloured footprint may remain visible.');
  if (pois.length && numbered) parts.push(`The small numbers on the map belong to points of interest. Draw each place where described below; for places without a footprint draw a small illustration or pictogram right beside the number, without covering the number:\n${listing}`);
  else if (pois.length) parts.push(`Draw each point of interest where described below. Places without a footprint are marked by a red dot: draw a small illustration or pictogram centred on the dot and covering it completely:\n${listing}`);
  if (text) {
    if (numbered) parts.push('The numbers on the map refer to the numbered list in the legend. Redraw every number exactly once at the same spot, small and clearly legible, in the lettering style of the map, without circles or markers. Never repeat a number anywhere else on the map. Keep the legend list complete: every number from 1 to ' + pois.length + ' in order, each with its name exactly as written.');
    if (names) parts.push('Redraw the street and water names at the same places and along the same streets as elegant hand lettering that matches the illustration style.');
  } else {
    parts.push('Do not write any text anywhere in the image: no letters, numbers, street names, labels, title, legend, compass or frame. Labels will be added afterwards.');
  }
  if (pois.length && !numbered) parts.push('The red dots are only placement markers: the finished image must not contain any red dots or markers.');
  return parts.join('\n\n');
}

// Nummern an die Orte setzen; Titel, Legende und Quellen kommen in eine Seitenleiste, damit die Karte frei bleibt.
// Liefert ein neues, breiteres Canvas.
function drawIlluOverlay(map_, pois, title, labels, refs = [], { credit: withCredit = true } = {}) {
  const u = map_.width / 1200; const pad = 22 * u;
  const font = (px, w = 400) => `${w} ${Math.round(px * u)}px Georgia, "Times New Roman", serif`;
  const ink = '#3b2412'; const paper = '#fbf6ec';
  const list = labels ? pois : [];
  const rowH = 22 * u; const headH = (title ? 64 : 0) * u + (list.length ? 34 : 0) * u;
  // unten Platz für den Quellenhinweis lassen (Gemini zeichnet die Legende oft etwas größer)
  const maxRows = Math.max(4, Math.floor((map_.height - headH - 3 * pad - 80 * u) / rowH));
  const cols = Math.max(1, Math.ceil(list.length / maxRows)); const rows = Math.ceil(list.length / cols);
  const m = document.createElement('canvas').getContext('2d');
  m.font = font(14);
  const colW = list.length ? Math.max(...list.map((p) => m.measureText(p.name).width)) + 34 * u : 0;
  m.font = font(30, 700);
  const titleW = title ? m.measureText(title).width : 0;
  const side = list.length || title || refs.length ? Math.ceil(Math.max(cols * colW, Math.min(titleW, 420 * u), 220 * u) + 2 * pad) : 0;

  const c = document.createElement('canvas');
  c.width = map_.width + side; c.height = map_.height;
  const g = c.getContext('2d');
  g.drawImage(map_, 0, 0);
  // Nur die Zahl, mit hellem Schein für die Lesbarkeit – keine Markierung auf der Zeichnung
  const number = (x, y, n, size = 15) => {
    g.font = font(size, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 4 * u; g.strokeStyle = 'rgba(255,250,240,0.95)'; g.strokeText(String(n), x, y);
    g.fillStyle = '#7c2d12'; g.fillText(String(n), x, y);
  };
  // Nummern neben die Orte setzen, damit sie die Zeichnungen nicht verdecken.
  // Je Ort die Richtung wählen, die am weitesten von anderen Orten und schon gesetzten Nummern entfernt ist.
  // Bei Wahrzeichen mit Grundriss kommt die Nummer knapp außerhalb des Grundrisses, nie auf einen anderen Grundriss.
  const W = map_.width; const H = map_.height;
  const pts = list.map((p) => (p.fp
    ? { x: ((p.fp.x1 + p.fp.x2) / 2) * W, y: ((p.fp.y1 + p.fp.y2) / 2) * H, hw: ((p.fp.x2 - p.fp.x1) / 2) * W, hh: ((p.fp.y2 - p.fp.y1) / 2) * H }
    : { x: p.fx * W, y: p.fy * H, hw: 10 * u, hh: 10 * u }));
  const boxes = list.filter((p) => p.fp).map((p) => ({ p, x1: p.fp.x1 * W, x2: p.fp.x2 * W, y1: p.fp.y1 * H, y2: p.fp.y2 * H }));
  const placed = []; const gap = 16 * u; const keepOff = 18 * u;
  list.forEach((p, i) => {
    const o = pts[i];
    let best = null;
    for (let k = 0; k < 8; k++) {
      const a = -Math.PI / 4 + (k * Math.PI) / 4; // zuerst rechts oben
      const x = o.x + Math.cos(a) * (o.hw + gap); const y = o.y - Math.sin(a) * (o.hh + gap);
      if (x < 14 * u || y < 14 * u || x > W - 14 * u || y > H - 14 * u) continue;
      if (boxes.some((b) => x > b.x1 - 6 * u && x < b.x2 + 6 * u && y > b.y1 - 6 * u && y < b.y2 + 6 * u)) continue;
      const near = Math.min(Infinity, ...pts.filter((_, j) => j !== i).map((q) => Math.hypot(q.x - x, q.y - y)), ...placed.map((q) => Math.hypot(q.x - x, q.y - y) - keepOff));
      if (!best || near > best.near) best = { x, y, near };
    }
    best ||= { x: o.x, y: o.y - o.hh - gap };
    placed.push(best);
    number(best.x, best.y, p.n);
  });

  if (side) {
    const x0 = map_.width;
    g.fillStyle = paper; g.fillRect(x0, 0, side, c.height);
    g.fillStyle = 'rgba(60,40,20,0.35)'; g.fillRect(x0, 0, Math.max(1, u), c.height);
    let y = pad;
    g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = ink;
    if (title) {
      g.font = font(titleW > side - 2 * pad ? 24 : 30, 700);
      g.fillText(title, x0 + pad, y + 22 * u, side - 2 * pad);
      y += 64 * u;
    }
    if (list.length) {
      g.font = font(15, 700); g.fillText('Orte', x0 + pad, y + 10 * u); y += 34 * u;
      list.forEach((p, i) => {
        const cx = x0 + pad + Math.floor(i / rows) * colW; const cy = y + (i % rows) * rowH + rowH / 2;
        g.fillStyle = '#7c2d12'; g.font = font(14, 700); g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(String(p.n), cx + 18 * u, cy);
        g.fillStyle = ink; g.font = font(14); g.textAlign = 'left'; g.fillText(p.name, cx + 26 * u, cy);
      });
    }
  }
  c.mapFrac = map_.width / c.width;
  if (withCredit) drawCredits(c, refs, c.mapFrac);
  return c;
}

// Quellenhinweis (OSM, KI, Fotovorlagen mit Urheber und Lizenz). Er muss buchstabengenau stimmen und kommt deshalb
// immer von der App, auch im Modus „aus einem Guss“. Mit Seitenleiste dort umbrochen, sonst unten rechts.
function drawCredits(c, refs, mapFrac = 1) {
  const g = c.getContext('2d'); const u = c.width * mapFrac / 1200; const pad = 22 * u;
  let credit = 'Kartendaten © OpenStreetMap-Mitwirkende · Illustration: KI (Gemini)';
  if (refs.length) credit += ` · Fotovorlagen von Wikimedia Commons: ${refs.map((r) => `${r.artist} (${r.license})`).join('; ')}`;
  g.font = `400 ${Math.round(10 * u)}px Georgia, "Times New Roman", serif`; g.fillStyle = '#3b2412'; g.textBaseline = 'alphabetic';
  if (mapFrac < 1) {
    const x0 = c.width * mapFrac + pad; const maxW = c.width - x0 - pad; const lines = [];
    for (const word of credit.split(' ')) {
      const last = lines[lines.length - 1];
      if (last !== undefined && g.measureText(`${last} ${word}`).width <= maxW) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word);
    }
    const lh = 13 * u; const top = c.height - 8 * u - (lines.length - 1) * lh - 11 * u;
    g.fillStyle = 'rgba(251,246,236,0.85)'; g.fillRect(x0 - 6 * u, top, maxW + 12 * u, lines.length * lh + 8 * u);
    g.fillStyle = '#3b2412'; g.textAlign = 'left';
    lines.forEach((l, i) => g.fillText(l, x0, c.height - 8 * u - (lines.length - 1 - i) * lh));
  } else {
    const w = g.measureText(credit).width + 12 * u;
    g.fillStyle = 'rgba(251,246,236,0.85)'; g.fillRect(c.width - w, c.height - 16 * u, w, 16 * u);
    g.fillStyle = '#3b2412'; g.textAlign = 'right'; g.fillText(credit, c.width - 6 * u, c.height - 5 * u);
  }
}

// Vorlage für den gewählten Modus: im Modus „aus einem Guss“ mit Straßennamen, Nummern und Legende
async function buildIlluInput(pois, refs) {
  const text = $('#il-lettering').value === 'gemini';
  const names = $('#il-streets').checked; const labels = $('#il-labels').checked; const title = $('#il-title').value.trim();
  // Im Modus „aus einem Guss“ mit Nummern dienen die Nummern als Anker; rote Punkte würde das Modell sonst übernehmen
  const numbered = text && labels && pois.length > 0;
  let tpl = await renderTemplate(pois, text && names, !numbered);
  let mapFrac = 1;
  if (text && (labels || title)) { tpl = drawIlluOverlay(tpl, pois, title, labels, [], { credit: false }); mapFrac = tpl.mapFrac; }
  const prompt = composeIlluPrompt(pois, refs, { text, names, panel: mapFrac < 1, mapFrac, place: $('#il-place').value.trim(), numbered });
  return { tpl, prompt, text, names, labels, title, mapFrac };
}

// Zweiter Durchgang: Wahrzeichen mit Foto und Grundriss einzeln in ihrem Bildausschnitt nachzeichnen. Gemini sieht dort
// nur die Umgebung des Grundrisses und kann das Gebäude kaum verschieben; der Ausschnitt kommt mit weichem Rand zurück.
const MAX_REFINE = 6;
const refinePrompt = (p) => [
  'Image 1 is a small part of an illustrated city map. The bright magenta outline marks the exact ground plan of a real landmark'
    + `${p.type ? ` (${p.type})` : ''}. Draw this landmark standing exactly on the magenta outline: its walls follow the outline, with the same orientation and size, seen from the same angle and in exactly the same illustration style, line work, colours and scale as the surrounding buildings.`,
  'Image 2 is a photo of the real building. Make the drawing resemble it (silhouette, towers, roof shapes, materials, colours), but do not copy the photo, its perspective or its background.',
  'Remove the magenta outline completely. If this landmark is already drawn somewhere else in this image, replace that copy with ordinary buildings or open space that match the surroundings.',
  'Keep everything else exactly unchanged: streets, other buildings, trees, water and all numbers and lettering, at the same positions, size and colours. Do not add any text.',
].join('\n\n');

async function refineLandmark(out, ref, mapFrac) {
  const fp = ref.poi.fp; const mapW = out.width * mapFrac; const H = out.height;
  const fw = (fp.x2 - fp.x1) * mapW; const fh = (fp.y2 - fp.y1) * H;
  // Quadrat um den Grundriss, groß genug für Umgebung und eine danebengerutschte Kopie aus dem ersten Durchgang
  const size = Math.round(Math.min(Math.max(Math.max(fw, fh) * 3, mapW * 0.2), mapW * 0.5, H));
  const cx = ((fp.x1 + fp.x2) / 2) * mapW; const cy = ((fp.y1 + fp.y2) / 2) * H - fh * 0.3; // etwas Luft nach oben für Türme
  const x0 = Math.round(Math.min(Math.max(cx - size / 2, 0), mapW - size));
  const y0 = Math.round(Math.min(Math.max(cy - size / 2, 0), H - size));
  const crop = document.createElement('canvas'); crop.width = size; crop.height = size;
  const g = crop.getContext('2d');
  g.drawImage(out, x0, y0, size, size, 0, 0, size, size);
  g.beginPath();
  for (const rings of fp.polys) for (const ring of rings) ring.forEach(([x, y], i) => (i ? g.lineTo(x * mapW - x0, y * H - y0) : g.moveTo(x * mapW - x0, y * H - y0)));
  g.closePath(); g.lineWidth = Math.max(2, size / 200); g.strokeStyle = '#ff00ff'; g.stroke();
  const res = await stylizeCanvas(crop, refinePrompt(ref.poi), [ref.image], state.config.resolutions?.includes('1K') ? '1K' : undefined);
  // Mit weichem Rand zurücksetzen, damit keine Kante entsteht
  const soft = document.createElement('canvas'); soft.width = size; soft.height = size;
  const s = soft.getContext('2d'); const f = Math.round(size * 0.06);
  s.filter = `blur(${Math.round(f / 2)}px)`; s.fillStyle = '#000'; s.fillRect(f, f, size - 2 * f, size - 2 * f); s.filter = 'none';
  s.globalCompositeOperation = 'source-in'; s.drawImage(res.canvas, 0, 0, size, size);
  out.getContext('2d').drawImage(soft, x0, y0);
}

$('#il-copy').addEventListener('click', async () => {
  const { prompt } = await buildIlluInput(collectPois(), []);
  await navigator.clipboard.writeText(prompt); // ohne Referenzfotos
  $('#st-status').textContent = 'Prompt kopiert. Als Bild dazu einen Screenshot des Ausschnitts ohne Beschriftungen verwenden.';
});

$('#il-run').addEventListener('click', async () => {
  const status = $('#st-status'); const btn = $('#il-run');
  btn.disabled = true; status.textContent = 'Zeichne Stadtkarte … das kann eine halbe Minute dauern.';
  try {
    const pois = collectPois();
    let refs = [];
    if ($('#il-refs').checked) {
      status.textContent = 'Hole Referenzfotos aus Wikidata …';
      try { refs = await loadReferences(pois); } catch (err) { console.warn('Referenzfotos:', err); }
    }
    // Wahrzeichen, die nachgezeichnet werden, bekommen ihr Foto erst im zweiten Durchgang
    const refine = $('#il-refine').checked ? refs.filter((r) => r.poi.fp).slice(0, MAX_REFINE) : [];
    const mainRefs = refs.filter((r) => !refine.includes(r)).map((r, i) => ({ ...r, index: i + 2 }));
    const inp = await buildIlluInput(pois, mainRefs);
    status.textContent = `Zeichne Stadtkarte${mainRefs.length ? ` mit ${mainRefs.length} Referenzfoto${mainRefs.length > 1 ? 's' : ''}` : ''} … das kann eine halbe Minute dauern.`;
    // Für lesbare Schrift im Modus „aus einem Guss“ in 2K rendern, falls das Modell es kann
    const res = await stylizeCanvas(inp.tpl, inp.prompt, mainRefs.map((r) => r.image), inp.text && state.config.resolutions?.includes('2K') ? '2K' : undefined);
    let out = res.canvas;
    let failed = 0;
    for (const [i, r] of refine.entries()) {
      status.textContent = `Zeichne Wahrzeichen ${i + 1} von ${refine.length} nach (${r.poi.name}) …`;
      try { await refineLandmark(out, r, inp.text ? inp.mapFrac : 1); } catch (err) { failed++; console.warn('Nachzeichnen:', r.poi.name, err); }
    }
    if (inp.text) {
      drawCredits(out, refs, inp.mapFrac);
    } else {
      if (inp.names) out.getContext('2d').drawImage(await renderNameLabels(out.width), 0, 0, out.width, out.height);
      out = drawIlluOverlay(out, pois, inp.title, inp.labels, refs);
    }
    showResult(out, 'stadtkarte-illustriert.png');
    const done = refine.length ? `, ${refine.length - failed} Wahrzeichen nachgezeichnet${failed ? `, ${failed} fehlgeschlagen` : ''}` : '';
    status.textContent = `Fertig (${res.model}${refs.length ? `, ${refs.length} Referenzfoto${refs.length > 1 ? 's' : ''}` : ''}${done}). Lage der Zeichnungen${inp.text ? ', Nummern und Schreibweisen' : ' und Nummern'} bitte gegen die Karte prüfen.`;
  } catch (err) {
    status.textContent = `Fehler: ${err.message || err}`;
  } finally { btn.disabled = !state.config.stylize; }
});

// ------------------------------------------------------------------ Start
(async function init() {
  try {
    state.config = await (await fetch('/api/config')).json();
    state.sessionId = (await (await fetch('/api/session', { method: 'POST' })).json()).id;
  } catch { addMsg('err', 'Server nicht erreichbar. Läuft "npm start"?'); return; }
  if (!state.config.chat) addMsg('sys', 'Der Chat ist noch nicht aktiv: Trage ANTHROPIC_API_KEY in die Datei .env ein und starte den Server neu.');
  else addMsg('bot', 'Hallo! Nenne mir einen Ort und eine Frage, z. B. **„15-Minuten-Fußweg um Deventer“**. Danach kannst du Grünflächen, Haltestellen oder Schulen ergänzen.');
  if (!state.config.stylize) { $('#st-run').disabled = true; $('#il-run').disabled = true; $('#st-status').textContent = 'Zum Stylisieren OPENROUTER_API_KEY in .env eintragen. „Prompt kopieren“ funktioniert auch ohne Key (z. B. für gemini.google.com).'; }
})();
