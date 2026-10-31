// Tests ohne Netzwerk: Nominatim, Valhalla, Overpass, Wikidata/Commons, OpenRouter und Claude werden gemockt.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { createSession, runTool, newChanges } from '../lib/tools.js';
import { buildOverpassQuery, overpassToFeatures } from '../lib/geo.js';
import { createApp } from '../server.js';

const realFetch = globalThis.fetch;

const sq = (w, s, e, n) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];

function mockExternal() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('127.0.0.1')) return realFetch(url, opts);
    if (u.includes('nominatim')) {
      return json([{ lat: '52.2554', lon: '6.1639', display_name: 'Deventer, Overijssel, Nederland', boundingbox: ['52.20', '52.30', '6.10', '6.22'] }]);
    }
    if (u.includes('/isochrone')) {
      return json({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { contour: 15, metric: 'time' }, geometry: { type: 'Polygon', coordinates: sq(6.15, 52.248, 6.18, 52.263) } }] });
    }
    if (u.includes('overpass')) {
      const q = new URLSearchParams(String(opts.body)).get('data');
      if (q.includes('out geom')) {
        const ring = [[6.17, 52.25], [6.19, 52.25], [6.19, 52.258], [6.17, 52.258], [6.17, 52.25]];
        return json({ elements: [{ type: 'way', id: 1, nodes: [1, 2, 3, 4, 1], tags: { leisure: 'park', name: 'Wilhelminapark' }, geometry: ring.map(([lon, lat]) => ({ lat, lon })) }] });
      }
      return json({ elements: [
        { type: 'node', id: 11, lat: 52.255, lon: 6.16, tags: { highway: 'bus_stop', name: 'Binnen' } },
        { type: 'node', id: 12, lat: 52.255, lon: 6.20, tags: { highway: 'bus_stop', name: 'Außen' } },
        { type: 'node', id: 13, lat: 52.256, lon: 6.165, tags: { railway: 'station', name: 'Bahnhof' } },
      ] });
    }
    if (u.includes('wikidata.org/w/api.php')) {
      return json({ entities: {
        Q1811227: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Lebuinuskerk 2011.jpg' } } }] } },
        Q999: { claims: {} },
      } });
    }
    if (u.includes('commons.wikimedia.org/w/api.php')) {
      return json({ query: {
        normalized: [{ from: 'File:Lebuinuskerk 2011.jpg', to: 'File:Lebuinuskerk 2011.jpg' }],
        pages: { 1: { title: 'File:Lebuinuskerk 2011.jpg', imageinfo: [{
          thumburl: 'https://upload.wikimedia.org/thumb/lebuinus.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lebuinuskerk_2011.jpg',
          extmetadata: { Artist: { value: '<a href="#">Jane Doe</a>' }, LicenseShortName: { value: 'CC BY-SA 3.0' } },
        }] } },
      } });
    }
    if (u.includes('upload.wikimedia.org')) {
      return new Response(Buffer.from('JPG'), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (u.includes('openrouter.ai/api/v1/images')) {
      assert.equal(opts.headers.Authorization, 'Bearer test-key');
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'google/gemini-2.5-flash-image');
      assert.equal(body.input_references[0].image_url.url, 'data:image/png;base64,QQ==');
      assert.equal(body.aspect_ratio, '3:2');
      assert.equal(body.resolution, '2K');
      assert.deepEqual(body.input_references.slice(1).map((r) => r.image_url.url), ['data:image/jpeg;base64,SlBH']);
      return json({ created: 1, data: [{ b64_json: 'QUJD', media_type: 'image/png' }] });
    }
    throw new Error(`Unerwarteter Aufruf: ${u}`);
  };
}

test.beforeEach(mockExternal);
test.afterEach(() => { globalThis.fetch = realFetch; });

test('Analysekette: Geocoding → Isochrone → Grünflächen zugeschnitten → Haltestellen gefiltert', async () => {
  const s = createSession();
  const g = await runTool(s, 'geocode', { query: 'Deventer' });
  assert.equal(g.features, 1);

  const iso = await runTool(s, 'isochrone', { minutes: [15] });
  assert.equal(iso.contours[0].minutes, 15);
  assert.ok(iso.total_area_km2 > 0);

  const green = await runTool(s, 'find_features', { category: 'green', within_layer_id: iso.layer_id });
  assert.equal(green.features, 1);
  const original = turf.area(turf.polygon(sq(6.17, 52.25, 6.19, 52.258)));
  const clipped = s.layers.get(green.layer_id).geojson.features[0];
  assert.ok(turf.area(clipped) < original * 0.75, 'Park muss auf die Isochrone zugeschnitten sein');
  assert.ok(turf.bbox(clipped)[2] <= 6.1801, 'Zuschnitt endet an der Isochronen-Grenze');

  const bus = await runTool(s, 'find_features', { category: 'transit', within_layer_id: iso.layer_id });
  assert.equal(bus.features, 2, 'Haltestelle außerhalb muss entfallen');
  assert.deepEqual(bus.by_subtype, { Bus: 1, Bahnhof: 1 });
});

test('Radiussuche, Puffer und keep_outside', async () => {
  const s = createSession();
  await runTool(s, 'geocode', { query: '52.2554, 6.1639' });
  const pts = await runTool(s, 'find_features', { category: 'transit', radius_m: 3000 });
  assert.equal(pts.features, 3, 'alle drei Punkte liegen im 3-km-Radius');
  const iso = await runTool(s, 'isochrone', { location_query: 'Deventer' });
  const buf = await runTool(s, 'geo_op', { op: 'buffer', layer_id: iso.layer_id, distance_m: 200 });
  assert.ok(buf.total_area_km2 > iso.total_area_km2);
  const outside = await runTool(s, 'geo_op', { op: 'keep_outside', layer_id: pts.layer_id, other_layer_id: iso.layer_id });
  assert.equal(outside.features, 1);
});

test('style_layer, remove_layer und Fehler bei unbekannter Ebene', async () => {
  const s = createSession();
  await runTool(s, 'geocode', { query: 'Deventer' });
  const id = [...s.layers.keys()][0];
  await runTool(s, 'style_layer', { layer_id: id, color: '#16a34a', fill_opacity: 2, name: 'Neu' });
  assert.equal(s.layers.get(id).color, '#16a34a');
  assert.equal(s.layers.get(id).fillOpacity, 1);
  await assert.rejects(runTool(s, 'style_layer', { layer_id: id, color: 'grün' }), /#rrggbb/);
  await assert.rejects(runTool(s, 'zoom_to_layer', { layer_id: 'L99' }), /existiert nicht/);
  await runTool(s, 'remove_layer', { layer_id: id });
  assert.equal(s.layers.size, 0);
});

test('Overpass-Tags werden validiert (keine Query-Injection)', () => {
  assert.throws(() => buildOverpassQuery({ tags: ['amenity=school"];out;'], kind: 'point', center: { lat: 1, lon: 1 }, radius_m: 10 }), /Ungültige/);
  const q = buildOverpassQuery({ tags: ['amenity=school'], kind: 'point', center: { lat: 1, lon: 2 }, radius_m: 500 });
  assert.match(q, /nwr\["amenity"="school"\]\(around:500,1,2\)/);
});

test('Server: Agent-Schleife mit Werkzeugaufruf, Ebenen in der Antwort', async () => {
  let call = 0;
  const fakeClaude = {
    messages: {
      create: async ({ messages }) => {
        call++;
        if (call === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'geocode', input: { query: 'Deventer' } }] };
        const last = messages[messages.length - 1].content[0];
        assert.equal(last.type, 'tool_result');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Standort gesetzt.' }] };
      },
    },
  };
  const server = createApp({ anthropic: fakeClaude }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { id } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id, message: 'Zeige Deventer' }) });
    const data = await r.json();
    assert.equal(r.status, 200);
    assert.equal(data.reply, 'Standort gesetzt.');
    assert.equal(data.upsert.length, 1);
    assert.equal(data.upsert[0].geojson.features[0].geometry.type, 'Point');
    assert.ok(Array.isArray(data.view));

    const p = await fetch(`${base}/api/session/${id}/layers/${data.upsert[0].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: '#00ff00' }) });
    assert.equal(p.status, 200);
    const d = await fetch(`${base}/api/session/${id}/layers/${data.upsert[0].id}`, { method: 'DELETE' });
    assert.equal(d.status, 200);
  } finally { server.close(); }
});

test('Server: ohne Keys klare Fehlermeldungen; Stylisieren mit Key liefert Bild', async () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENROUTER_API_KEY, m: process.env.OPENROUTER_IMAGE_MODEL };
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_IMAGE_MODEL;
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let r = await post('/api/chat', { message: 'hi' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
    r = await post('/api/stylize', { image: 'data:image/png;base64,QQ==', prompt: 'x' });
    assert.equal(r.status, 400);
    process.env.OPENROUTER_API_KEY = 'test-key';
    r = await post('/api/stylize', { image: 'data:image/png;base64,QQ==', prompt: 'x', aspect_ratio: '3:2', references: ['data:image/jpeg;base64,SlBH'], resolution: '2K' });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.image, 'data:image/png;base64,QUJD');
    assert.equal(d.model, 'google/gemini-2.5-flash-image');
    r = await post('/api/stylize', { image: 'kein-bild', prompt: 'x' });
    assert.equal(r.status, 400);
    r = await post('/api/stylize', { image: 'data:image/png;base64,QQ==', prompt: 'x', references: ['https://example.com/x.jpg'] });
    assert.equal(r.status, 400, 'Referenzen nur als Data-URL');
  } finally {
    server.close();
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o) process.env.OPENROUTER_API_KEY = saved.o; else delete process.env.OPENROUTER_API_KEY;
    if (saved.m) process.env.OPENROUTER_IMAGE_MODEL = saved.m;
  }
});

test('Referenzfotos: Wikidata-Bild → Commons-Vorschau mit Urheber und Lizenz', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/references`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qids: ['Q1811227', 'Q999', 'kein-qid'] }) });
    const { references } = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(references), ['Q1811227'], 'nur Einträge mit Foto');
    assert.equal(references.Q1811227.image, 'data:image/jpeg;base64,SlBH');
    assert.equal(references.Q1811227.artist, 'Jane Doe', 'HTML aus dem Urheber entfernt');
    assert.equal(references.Q1811227.license, 'CC BY-SA 3.0');
  } finally { server.close(); }
});

test('OSM-Objekte behalten gültige Wikidata-IDs', () => {
  const feats = overpassToFeatures({ elements: [
    { type: 'node', id: 1, lat: 52.25, lon: 6.16, tags: { amenity: 'place_of_worship', name: 'Lebuinuskerk', wikidata: 'Q1811227' } },
    { type: 'node', id: 2, lat: 52.25, lon: 6.17, tags: { amenity: 'place_of_worship', name: 'Kapelle', wikidata: 'kaputt' } },
  ] }, { tags: ['amenity=place_of_worship'], kind: 'point' });
  assert.equal(feats[0].properties.wikidata, 'Q1811227');
  assert.equal(feats[0].properties.subtype, 'Kirche/Gotteshaus');
  assert.equal(feats[1].properties.wikidata, undefined);
});

test('Sehenswürdigkeiten behalten ihren Grundriss, große Flächen nicht', () => {
  const ring = (x, y, d) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]].map(([lon, lat]) => ({ lat, lon }));
  const way = (id, d, tags) => ({ type: 'way', id, nodes: [1, 2, 3, 4, 1].map((n) => id * 10 + n), geometry: ring(6.16, 52.25, d), tags });
  const json = { elements: [
    way(10, 0.0005, { amenity: 'place_of_worship', name: 'Kerk' }), // ca. 34 × 55 m
    way(11, 0.01, { tourism: 'attraction', name: 'Park' }), // ca. 0,7 km² → zu groß
  ] };
  const feats = overpassToFeatures(json, { tags: ['amenity=place_of_worship', 'tourism=attraction'], kind: 'point', footprints: true });
  assert.equal(feats[0].geometry.type, 'Point');
  assert.equal(feats[0].properties.footprint.type, 'Polygon');
  assert.equal(feats[0].properties.footprint.coordinates[0].length, 5);
  assert.equal(feats[1].properties.footprint, undefined);
  const plain = overpassToFeatures(json, { tags: ['amenity=place_of_worship'], kind: 'point' });
  assert.equal(plain[0].properties.footprint, undefined);
  assert.match(buildOverpassQuery({ tags: ['amenity=place_of_worship'], kind: 'point', center: [6.16, 52.25], radius_m: 500, footprints: true }), /out geom tags;/);
});

test('newChanges ist leer', () => {
  const c = newChanges();
  assert.equal(c.upsert.size, 0);
  assert.equal(c.view, null);
});
