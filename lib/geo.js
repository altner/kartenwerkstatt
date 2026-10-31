// Zugriff auf die externen Geodaten-Dienste (alle ohne API-Key nutzbar):
//  - Nominatim (Geocoding), Valhalla (Isochronen), Overpass (OSM-Objekte)
import osmtogeojson from 'osmtogeojson';
import * as turf from '@turf/turf';

export const UA = 'Kartenwerkstatt/0.1 (lokale Analyse-App)';
const env = (k, d) => process.env[k] || d;

export async function fetchJson(url, opts = {}, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`${new URL(url).host} antwortete mit ${r.status}: ${body.slice(0, 200)}`);
    }
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Zeitüberschreitung bei ${new URL(url).host}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- Geocoding
export async function geocode(query) {
  const m = String(query).match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    return { lat, lon, name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, bbox: null };
  }
  const url = `${env('NOMINATIM_URL', 'https://nominatim.openstreetmap.org')}/search?` +
    new URLSearchParams({ q: query, format: 'jsonv2', limit: '1' });
  const res = await fetchJson(url, {}, 20000);
  if (!res.length) throw new Error(`Ort nicht gefunden: "${query}"`);
  const r = res[0];
  const [s, n, w, e] = r.boundingbox.map(Number);
  return { lat: Number(r.lat), lon: Number(r.lon), name: r.display_name, bbox: [w, s, e, n] };
}

// ---------------------------------------------------------------- Isochronen
const COSTING = { pedestrian: 'pedestrian', bicycle: 'bicycle', auto: 'auto' };
export const MODE_LABEL = { pedestrian: 'zu Fuß', bicycle: 'per Rad', auto: 'mit dem Auto' };

export async function isochrone({ lat, lon, mode = 'pedestrian', minutes = [15] }) {
  const costing = COSTING[mode];
  if (!costing) throw new Error(`Unbekannter Modus: ${mode}`);
  const mins = [...new Set(minutes.map(Number))].filter((m) => m > 0 && m <= 60).sort((a, b) => a - b).slice(0, 4);
  if (!mins.length) throw new Error('Minuten müssen zwischen 1 und 60 liegen.');
  const body = {
    locations: [{ lat, lon }],
    costing,
    contours: mins.map((time) => ({ time })),
    polygons: true,
    denoise: 0.5,
    generalize: 20,
  };
  const fc = await fetchJson(`${env('VALHALLA_URL', 'https://valhalla1.openstreetmap.de')}/isochrone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const feats = (fc.features || []).filter((f) => /Polygon/.test(f.geometry?.type));
  if (!feats.length) throw new Error('Der Routing-Dienst lieferte keine Isochrone (Punkt evtl. nicht erreichbar).');
  // äußere Konturen zuerst, damit innere darüber gezeichnet werden
  feats.sort((a, b) => (b.properties?.contour ?? 0) - (a.properties?.contour ?? 0));
  return feats.map((f) => {
    const m = f.properties?.contour ?? 0;
    return turf.feature(f.geometry, {
      minutes: m,
      subtype: `${m} Min.`,
      area_km2: Math.round((turf.area(f) / 1e6) * 100) / 100,
    });
  });
}

// ---------------------------------------------------------------- OSM-Kategorien
// kind: 'point' = Objekte werden auf Punkte reduziert, 'area' = Flächen bleiben erhalten
export const CATEGORIES = {
  transit: {
    label: 'ÖPNV-Haltestellen', kind: 'point',
    tags: ['highway=bus_stop', 'railway=station', 'railway=halt', 'railway=tram_stop', 'railway=subway_entrance'],
  },
  green: {
    label: 'Grünflächen', kind: 'area',
    tags: ['leisure=park', 'leisure=garden', 'leisure=nature_reserve', 'leisure=playground', 'landuse=forest', 'landuse=grass', 'landuse=meadow', 'landuse=recreation_ground'],
  },
  schools: { label: 'Schulen', kind: 'point', tags: ['amenity=school'] },
  childcare: { label: 'Kitas/Kindergärten', kind: 'point', tags: ['amenity=kindergarten', 'amenity=childcare'] },
  supermarkets: { label: 'Supermärkte', kind: 'point', tags: ['shop=supermarket', 'shop=convenience', 'shop=bakery'] },
  food: { label: 'Gastronomie', kind: 'point', tags: ['amenity=restaurant', 'amenity=cafe', 'amenity=fast_food', 'amenity=pub', 'amenity=bar'] },
  healthcare: { label: 'Gesundheit', kind: 'point', tags: ['amenity=hospital', 'amenity=clinic', 'amenity=doctors', 'amenity=pharmacy', 'amenity=dentist'] },
  shops: { label: 'Geschäfte', kind: 'point', tags: ['shop=*'] },
  cycling: { label: 'Fahrrad-Infrastruktur', kind: 'point', tags: ['amenity=bicycle_parking', 'amenity=bicycle_rental', 'shop=bicycle'] },
  parking: { label: 'Parkplätze', kind: 'area', tags: ['amenity=parking'] },
  water: { label: 'Gewässer', kind: 'area', tags: ['natural=water'] },
  buildings: { label: 'Gebäude', kind: 'area', tags: ['building=*'] },
  sights: {
    // footprints: Gebäudeumrisse mitliefern, damit die illustrierte Stadtkarte Wahrzeichen an der richtigen Stelle zeichnet
    label: 'Sehenswürdigkeiten', kind: 'point', footprints: true,
    tags: ['tourism=attraction', 'tourism=museum', 'tourism=viewpoint', 'tourism=artwork', 'historic=monument', 'historic=castle',
      'historic=city_gate', 'historic=ruins', 'historic=memorial', 'amenity=place_of_worship', 'amenity=theatre', 'man_made=windmill', 'man_made=lighthouse'],
  },
};

const SUBTYPE_LABELS = {
  'highway=bus_stop': 'Bus', 'railway=station': 'Bahnhof', 'railway=halt': 'Haltepunkt',
  'railway=tram_stop': 'Tram', 'railway=subway_entrance': 'U-Bahn',
  'leisure=park': 'Park', 'leisure=garden': 'Garten', 'leisure=nature_reserve': 'Naturschutzgebiet',
  'leisure=playground': 'Spielplatz', 'landuse=forest': 'Wald', 'landuse=grass': 'Rasen',
  'landuse=meadow': 'Wiese', 'landuse=recreation_ground': 'Freizeitfläche',
  'amenity=school': 'Schule', 'amenity=kindergarten': 'Kindergarten', 'amenity=childcare': 'Kita',
  'shop=supermarket': 'Supermarkt', 'shop=convenience': 'Kiosk/Laden', 'shop=bakery': 'Bäckerei',
  'amenity=restaurant': 'Restaurant', 'amenity=cafe': 'Café', 'amenity=fast_food': 'Fast Food',
  'amenity=pub': 'Kneipe', 'amenity=bar': 'Bar',
  'amenity=hospital': 'Krankenhaus', 'amenity=clinic': 'Klinik', 'amenity=doctors': 'Arzt',
  'amenity=pharmacy': 'Apotheke', 'amenity=dentist': 'Zahnarzt',
  'amenity=bicycle_parking': 'Fahrradparkplatz', 'amenity=bicycle_rental': 'Fahrradverleih',
  'shop=bicycle': 'Fahrradladen', 'amenity=parking': 'Parkplatz', 'natural=water': 'Gewässer',
  'tourism=attraction': 'Sehenswürdigkeit', 'tourism=museum': 'Museum', 'tourism=viewpoint': 'Aussichtspunkt',
  'tourism=artwork': 'Kunstwerk', 'historic=monument': 'Denkmal', 'historic=castle': 'Burg/Schloss',
  'historic=city_gate': 'Stadttor', 'historic=ruins': 'Ruine', 'historic=memorial': 'Gedenkstätte',
  'amenity=place_of_worship': 'Kirche/Gotteshaus', 'amenity=theatre': 'Theater', 'man_made=windmill': 'Windmühle',
  'man_made=lighthouse': 'Leuchtturm',
};

const TAG_RE = /^[A-Za-z0-9_:\-]+=([A-Za-z0-9_:\-|]+|\*)$/;

export function validateTags(tags) {
  const bad = tags.filter((t) => !TAG_RE.test(t));
  if (bad.length) throw new Error(`Ungültige OSM-Tags: ${bad.join(', ')} (Format: schluessel=wert oder schluessel=*)`);
  return tags;
}

function subtypeOf(props, tags) {
  for (const t of tags) {
    const [k, v] = t.split('=');
    if (props[k] !== undefined && (v === '*' || props[k] === v)) {
      return SUBTYPE_LABELS[`${k}=${props[k]}`] || SUBTYPE_LABELS[t] || String(props[k]).replace(/_/g, ' ');
    }
  }
  return 'Sonstige';
}

export function buildOverpassQuery({ tags, kind, center, radius_m, bbox, footprints = false }) {
  validateTags(tags);
  let filter;
  if (center && radius_m) {
    filter = `(around:${Math.round(radius_m)},${center.lat},${center.lon})`;
  } else if (bbox) {
    const [w, s, e, n] = bbox;
    filter = `(${s},${w},${n},${e})`;
  } else {
    throw new Error('Für die OSM-Abfrage fehlt ein Suchbereich (Mittelpunkt + Radius oder Fläche).');
  }
  const parts = tags.map((t) => {
    const [k, v] = t.split('=');
    const sel = v === '*' ? `["${k}"]` : v.includes('|') ? `["${k}"~"^(${v})$"]` : `["${k}"="${v}"]`;
    return `  nwr${sel}${filter};`;
  });
  const out = kind === 'area' || footprints ? 'out geom tags;' : 'out center tags;';
  return `[out:json][timeout:60];\n(\n${parts.join('\n')}\n);\n${out}`;
}

const MAX_FOOTPRINT_M2 = 40000; // größere Flächen (Parks, Gelände) sind keine Gebäudeumrisse
const round6 = (c) => (typeof c[0] === 'number' ? c.map((v) => Math.round(v * 1e6) / 1e6) : c.map(round6));

export function overpassToFeatures(json, { tags, kind, footprints = false }) {
  const dom = osmtogeojson(json);
  const out = [];
  for (const f of dom.features) {
    if (!f.geometry) continue;
    const p = f.properties || {};
    let geom = f.geometry;
    let footprint = null;
    if (kind === 'point') {
      if (geom.type !== 'Point') {
        if (footprints && /Polygon/.test(geom.type) && turf.area(f) <= MAX_FOOTPRINT_M2) footprint = { type: geom.type, coordinates: round6(geom.coordinates) };
        try { geom = turf.centroid(f).geometry; } catch { continue; }
      }
    } else if (!/Polygon/.test(geom.type)) {
      continue; // Linien und Punkte sind für Flächenabfragen unbrauchbar
    }
    const props = {
      name: p.name || '',
      subtype: subtypeOf(p, tags),
      osm_id: f.id || `${p.type || ''}/${p.id || ''}`,
    };
    // Verweis auf Wikidata, z. B. für Referenzfotos bei der illustrierten Stadtkarte
    if (/^Q\d+$/.test(p.wikidata || '')) props.wikidata = p.wikidata;
    if (footprint) props.footprint = footprint;
    if (kind === 'area') props.area_m2 = Math.round(turf.area({ type: 'Feature', geometry: geom, properties: {} }));
    out.push(turf.feature(geom, props));
  }
  return out;
}

export async function queryOverpass({ tags, kind, center, radius_m, bbox, footprints = false }) {
  const query = buildOverpassQuery({ tags, kind, center, radius_m, bbox, footprints });
  const json = await fetchJson(env('OVERPASS_URL', 'https://overpass-api.de/api/interpreter'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }).toString(),
  }, 100000);
  return overpassToFeatures(json, { tags, kind, footprints });
}
