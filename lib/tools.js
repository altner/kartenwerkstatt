// Werkzeuge, die der Chat-Agent aufrufen kann, plus Sitzungs-/Ebenenverwaltung.
import * as turf from '@turf/turf';
import {
  geocode, isochrone, queryOverpass, CATEGORIES, MODE_LABEL, validateTags,
} from './geo.js';

export const PALETTE = [
  '#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#475569', '#ea580c',
];
const MAX_FEATURES = 6000;

export function createSession() {
  return { layers: new Map(), counter: 0, lastCenter: null, history: [], changes: newChanges() };
}
export function newChanges() {
  return { upsert: new Set(), remove: new Set(), view: null };
}

function groupColors(features) {
  const subs = [...new Set(features.map((f) => f.properties?.subtype).filter(Boolean))];
  const map = {};
  subs.forEach((s, i) => { map[s] = PALETTE[(i + 1) % PALETTE.length]; });
  return map;
}

export function addLayer(session, { name, features, color, groupBy = null, fillOpacity = 0.45 }) {
  const id = `L${++session.counter}`;
  const geojson = turf.featureCollection(features);
  const layer = {
    id, name, geojson, groupBy, fillOpacity, visible: true,
    color: color || PALETTE[(session.counter - 1) % PALETTE.length],
    groupColors: groupBy ? groupColors(features) : {},
  };
  session.layers.set(id, layer);
  session.changes.upsert.add(id);
  return layer;
}

export function layerSummary(layer) {
  const feats = layer.geojson.features;
  const counts = {};
  for (const f of feats) {
    const s = f.properties?.subtype || '–';
    counts[s] = (counts[s] || 0) + 1;
  }
  const geomTypes = [...new Set(feats.map((f) => f.geometry.type.replace('Multi', '')))];
  const out = { layer_id: layer.id, name: layer.name, features: feats.length, geometry: geomTypes.join('/'), by_subtype: counts };
  if (geomTypes.includes('Polygon')) {
    out.total_area_km2 = Math.round((turf.area(layer.geojson) / 1e6) * 1000) / 1000;
  }
  return out;
}

export function publicLayer(layer) {
  return { ...layer, summary: layerSummary(layer) };
}

function getLayer(session, id) {
  const l = session.layers.get(id);
  if (!l) throw new Error(`Ebene ${id} existiert nicht. Vorhandene Ebenen: ${[...session.layers.keys()].join(', ') || 'keine'}`);
  return l;
}

async function resolveCenter(session, input) {
  if (input.center && typeof input.center === 'object' && input.center.lat != null) return { lat: input.center.lat, lon: input.center.lon };
  if (input.location_query) {
    const g = await geocode(input.location_query);
    return { lat: g.lat, lon: g.lon, name: g.name, bbox: g.bbox };
  }
  if (input.lat != null && input.lon != null) return { lat: input.lat, lon: input.lon };
  if (session.lastCenter) return session.lastCenter;
  throw new Error('Kein Standort bekannt. Bitte Ort nennen (location_query) oder zuerst geocode aufrufen.');
}

function outerPolygon(layer) {
  const polys = layer.geojson.features.filter((f) => /Polygon/.test(f.geometry.type));
  if (!polys.length) throw new Error(`Ebene ${layer.id} enthält keine Flächen.`);
  return polys.reduce((a, b) => (turf.area(b) >= turf.area(a) ? b : a));
}

function unionAll(features) {
  const polys = features.filter((f) => /Polygon/.test(f.geometry.type));
  if (!polys.length) return null;
  let acc = polys[0];
  for (let i = 1; i < polys.length; i++) {
    try { acc = turf.union(turf.featureCollection([acc, polys[i]])) || acc; } catch { /* ungültige Geometrie überspringen */ }
  }
  return acc;
}

function safeIntersect(a, b) {
  try { return turf.intersect(turf.featureCollection([a, b])); } catch { return null; }
}

// ------------------------------------------------------------------ Werkzeugdefinitionen
export const toolDefinitions = [
  {
    name: 'geocode',
    description: 'Sucht einen Ort (Adresse, Stadt, Sehenswürdigkeit) oder liest "lat, lon" und setzt ihn als aktuellen Standort. Legt eine Markierungs-Ebene an und zoomt die Karte dorthin.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Ortsname oder "lat, lon"' } }, required: ['query'] },
  },
  {
    name: 'isochrone',
    description: 'Erzeugt Erreichbarkeits-Flächen (Isochronen) um einen Standort. Modus: pedestrian (zu Fuß), bicycle, auto. Nutzt den aktuellen Standort, wenn keiner angegeben ist.',
    input_schema: {
      type: 'object',
      properties: {
        location_query: { type: 'string', description: 'Ortsname; weglassen, um den aktuellen Standort zu nutzen' },
        mode: { type: 'string', enum: ['pedestrian', 'bicycle', 'auto'] },
        minutes: { type: 'array', items: { type: 'number' }, description: 'Reisezeiten in Minuten, z. B. [5,10,15] (max. 4 Werte, max. 60)' },
      },
    },
  },
  {
    name: 'find_features',
    description: 'Holt OpenStreetMap-Objekte als neue Ebene. Entweder eine vordefinierte category oder eigene osm_tags ("schluessel=wert", "schluessel=*"). Suchbereich: within_layer_id (äußerste Fläche einer Isochronen-Ebene, Flächen werden darauf zugeschnitten) ODER Radius um den Standort.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: Object.keys(CATEGORIES), description: Object.entries(CATEGORIES).map(([k, v]) => `${k}=${v.label}`).join('; ') },
        osm_tags: { type: 'array', items: { type: 'string' }, description: 'Eigene OSM-Tags statt category' },
        kind: { type: 'string', enum: ['point', 'area'], description: 'Nur bei osm_tags: Punkte oder Flächen' },
        name: { type: 'string', description: 'Name der neuen Ebene' },
        within_layer_id: { type: 'string' },
        radius_m: { type: 'number', description: 'Radius in Metern (max. 5000)' },
        location_query: { type: 'string', description: 'Mittelpunkt als Ortsname, sonst aktueller Standort' },
      },
    },
  },
  {
    name: 'geo_op',
    description: 'Geometrie-Operation auf Ebenen. buffer (distance_m), clip (Ebene auf andere zuschneiden), subtract (andere abziehen), keep_inside / keep_outside (ganze Objekte behalten, die in/außerhalb der anderen Ebene liegen). Beispiel „Gebäude weiter als 500 m vom Park“: buffer der Parks 500 m, dann keep_outside auf Gebäuden.',
    input_schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['buffer', 'clip', 'subtract', 'keep_inside', 'keep_outside'] },
        layer_id: { type: 'string' },
        other_layer_id: { type: 'string' },
        distance_m: { type: 'number' },
        name: { type: 'string' },
      },
      required: ['op', 'layer_id'],
    },
  },
  {
    name: 'style_layer',
    description: 'Ändert Name, Farbe, Deckkraft, Sichtbarkeit oder Gruppenfarben einer Ebene.',
    input_schema: {
      type: 'object',
      properties: {
        layer_id: { type: 'string' },
        name: { type: 'string' },
        color: { type: 'string', description: 'Hex-Farbe, z. B. #16a34a' },
        fill_opacity: { type: 'number', description: '0 bis 1' },
        visible: { type: 'boolean' },
        group_colors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Farbe je Untertyp, z. B. {"Bus":"#ff0000"}' },
      },
      required: ['layer_id'],
    },
  },
  {
    name: 'zoom_to_layer',
    description: 'Zoomt die Karte auf die Ausdehnung einer Ebene.',
    input_schema: { type: 'object', properties: { layer_id: { type: 'string' } }, required: ['layer_id'] },
  },
  {
    name: 'remove_layer',
    description: 'Entfernt eine Ebene.',
    input_schema: { type: 'object', properties: { layer_id: { type: 'string' } }, required: ['layer_id'] },
  },
  {
    name: 'list_layers',
    description: 'Listet alle Ebenen mit Anzahl der Objekte und Flächen.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ------------------------------------------------------------------ Ausführung
const HEX = /^#[0-9a-fA-F]{6}$/;

export async function runTool(session, name, input = {}) {
  switch (name) {
    case 'geocode': {
      const g = await geocode(input.query);
      session.lastCenter = { lat: g.lat, lon: g.lon, name: g.name };
      const layer = addLayer(session, {
        name: `Standort: ${String(g.name).split(',')[0]}`,
        features: [turf.point([g.lon, g.lat], { name: g.name, subtype: 'Standort' })],
        color: '#dc2626',
      });
      session.changes.view = g.bbox || [g.lon - 0.01, g.lat - 0.007, g.lon + 0.01, g.lat + 0.007];
      return { ...layerSummary(layer), lat: g.lat, lon: g.lon, display_name: g.name };
    }

    case 'isochrone': {
      const c = await resolveCenter(session, input);
      const mode = input.mode || 'pedestrian';
      const minutes = input.minutes?.length ? input.minutes : [15];
      const feats = await isochrone({ lat: c.lat, lon: c.lon, mode, minutes });
      session.lastCenter = { lat: c.lat, lon: c.lon, name: c.name || session.lastCenter?.name };
      const multi = feats.length > 1;
      const layer = addLayer(session, {
        name: `${feats.map((f) => f.properties.minutes).sort((a, b) => a - b).join('/')}-Min.-Isochrone ${MODE_LABEL[mode]}`,
        features: feats,
        groupBy: multi ? 'subtype' : null,
        color: '#dc2626',
        fillOpacity: 0.18,
      });
      session.changes.view = turf.bbox(layer.geojson);
      return { ...layerSummary(layer), contours: feats.map((f) => ({ minutes: f.properties.minutes, area_km2: f.properties.area_km2 })) };
    }

    case 'find_features': {
      let tags; let kind; let label;
      if (input.category) {
        const cat = CATEGORIES[input.category];
        if (!cat) throw new Error(`Unbekannte Kategorie: ${input.category}`);
        ({ tags, kind, label } = cat);
      } else if (input.osm_tags?.length) {
        tags = validateTags(input.osm_tags);
        kind = input.kind || 'point';
        label = tags.join(', ');
      } else {
        throw new Error('category oder osm_tags angeben.');
      }

      let poly = null;
      let bbox = null;
      let center = null;
      let radius = null;
      if (input.within_layer_id) {
        poly = outerPolygon(getLayer(session, input.within_layer_id));
        bbox = turf.bbox(poly);
        const diagKm = turf.distance([bbox[0], bbox[1]], [bbox[2], bbox[3]]);
        if (tags.includes('building=*') && diagKm > 4) throw new Error('Bereich für Gebäude zu groß (max. ca. 4 km Diagonale). Bitte kleinere Isochrone nutzen.');
        if (diagKm > 30) throw new Error('Bereich zu groß (max. 30 km Diagonale).');
      } else {
        center = await resolveCenter(session, input);
        radius = Math.min(Number(input.radius_m) || 1000, 5000);
        if (tags.includes('building=*') && radius > 1500) throw new Error('Für Gebäude max. 1500 m Radius.');
      }

      let feats = await queryOverpass({ tags, kind, center, radius_m: radius, bbox });

      if (poly) {
        const kept = [];
        for (const f of feats) {
          if (kind === 'point') {
            if (turf.booleanPointInPolygon(f, poly)) kept.push(f);
          } else {
            const cut = safeIntersect(f, poly);
            if (cut) { cut.properties = { ...f.properties, area_m2: Math.round(turf.area(cut)) }; kept.push(cut); }
          }
        }
        feats = kept;
      } else if (kind === 'point') {
        feats = feats.filter((f) => turf.distance(f, [center.lon, center.lat]) * 1000 <= radius * 1.02);
      }

      let note;
      if (feats.length > MAX_FEATURES) { feats = feats.slice(0, MAX_FEATURES); note = `Auf ${MAX_FEATURES} Objekte gekürzt.`; }
      const layer = addLayer(session, {
        name: input.name || label,
        features: feats,
        groupBy: 'subtype',
        fillOpacity: kind === 'area' ? 0.55 : 0.9,
      });
      session.changes.view = session.changes.view || (feats.length ? turf.bbox(layer.geojson) : null);
      return { ...layerSummary(layer), source: 'OpenStreetMap (Overpass)', ...(note ? { note } : {}) };
    }

    case 'geo_op': {
      const a = getLayer(session, input.layer_id);
      const op = input.op;
      let feats = [];
      let name = input.name;
      if (op === 'buffer') {
        const d = Number(input.distance_m);
        if (!(d > 0)) throw new Error('distance_m (>0) fehlt.');
        const u = unionAll(a.geojson.features.map((f) => (/Polygon/.test(f.geometry.type) ? f : turf.buffer(f, 0.001, { units: 'kilometers' }))));
        const buf = turf.buffer(u, d / 1000, { units: 'kilometers' });
        feats = [turf.feature(buf.geometry, { subtype: `${d} m Puffer`, name: `${d} m Puffer` })];
        name = name || `${a.name} + ${d} m Puffer`;
      } else {
        const b = getLayer(session, input.other_layer_id);
        const bUnion = unionAll(b.geojson.features);
        if (!bUnion) throw new Error(`Ebene ${b.id} enthält keine Flächen.`);
        if (op === 'clip') {
          for (const f of a.geojson.features) { const c = safeIntersect(f, bUnion); if (c) { c.properties = { ...f.properties }; feats.push(c); } }
          name = name || `${a.name} (zugeschnitten)`;
        } else if (op === 'subtract') {
          for (const f of a.geojson.features) {
            try { const c = turf.difference(turf.featureCollection([f, bUnion])); if (c) { c.properties = { ...f.properties }; feats.push(c); } } catch { /* überspringen */ }
          }
          name = name || `${a.name} (ohne ${b.name})`;
        } else if (op === 'keep_inside' || op === 'keep_outside') {
          const want = op === 'keep_inside';
          for (const f of a.geojson.features) { if (turf.booleanIntersects(f, bUnion) === want) feats.push(f); }
          name = name || `${a.name} (${want ? 'innerhalb' : 'außerhalb'} ${b.name})`;
        } else throw new Error(`Unbekannte Operation: ${op}`);
      }
      const layer = addLayer(session, {
        name, features: feats, groupBy: a.groupBy, color: a.color,
        fillOpacity: op === 'buffer' ? 0.2 : a.fillOpacity,
      });
      if (a.groupBy) layer.groupColors = { ...a.groupColors, ...layer.groupColors };
      return layerSummary(layer);
    }

    case 'style_layer': {
      const l = getLayer(session, input.layer_id);
      if (input.name) l.name = input.name;
      if (input.color) { if (!HEX.test(input.color)) throw new Error('Farbe als #rrggbb angeben.'); l.color = input.color; }
      if (input.fill_opacity != null) l.fillOpacity = Math.min(1, Math.max(0, Number(input.fill_opacity)));
      if (input.visible != null) l.visible = !!input.visible;
      if (input.group_colors) {
        for (const [k, v] of Object.entries(input.group_colors)) { if (HEX.test(v)) l.groupColors[k] = v; }
      }
      session.changes.upsert.add(l.id);
      return layerSummary(l);
    }

    case 'zoom_to_layer': {
      const l = getLayer(session, input.layer_id);
      if (!l.geojson.features.length) throw new Error('Ebene ist leer.');
      session.changes.view = turf.bbox(l.geojson);
      return { ok: true };
    }

    case 'remove_layer': {
      const l = getLayer(session, input.layer_id);
      session.layers.delete(l.id);
      session.changes.upsert.delete(l.id);
      session.changes.remove.add(l.id);
      return { removed: l.id };
    }

    case 'list_layers':
      return { layers: [...session.layers.values()].map(layerSummary) };

    default:
      throw new Error(`Unbekanntes Werkzeug: ${name}`);
  }
}
