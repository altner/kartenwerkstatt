import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  createSession, newChanges, toolDefinitions, runTool, publicLayer,
} from './lib/tools.js';
import { fetchReferences } from './lib/wiki.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `Du bist der Analyse-Assistent der "Kartenwerkstatt", einer Web-App für GIS- und Standortanalysen auf Basis von OpenStreetMap.
Du erzeugst Karten-Ebenen ausschließlich über deine Werkzeuge (geocode, isochrone, find_features, geo_op, style_layer, ...). Die Karte neben dem Chat zeigt die Ergebnisse sofort.

Regeln:
- Antworte in der Sprache der Nutzerin/des Nutzers (Standard: Deutsch), knapp und sachlich.
- Nenne nur Zahlen, die aus Werkzeugergebnissen stammen. Erfinde keine Daten.
- Rate keine Standorte: Wenn kein Ort genannt ist und keiner bekannt ist, frage nach. Ein auf der Karte markierter Punkt wird dir als "Markierter Punkt: lat, lon" mitgegeben.
- Standard für Erreichbarkeit: zu Fuß (pedestrian), 15 Minuten.
- Für „Grünflächen in der Isochrone“ erst isochrone, dann find_features mit within_layer_id (Flächen werden dabei automatisch zugeschnitten).
- Für Punkte im Umkreis find_features mit radius_m (z. B. 1000 bei „1 km Radius“).
- Für Sehenswürdigkeiten, Kirchen, Museen usw. (z. B. für eine illustrierte Stadtkarte) find_features mit category sights.
- Fasse nach den Werkzeugaufrufen kurz zusammen: was wurde erzeugt, Anzahl/Fläche, Datenquelle (OSM), und weise auf relevante Einschränkungen hin (z. B. OSM-Daten können unvollständig sein; Isochronen sind Näherungen des Wegenetzes).
- Mehrere unabhängige Werkzeugaufrufe darfst du in einer Runde bündeln.`;

export function createApp({ anthropic, sessions = new Map() } = {}) {
  const app = express();
  app.use(express.json({ limit: '40mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const model = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  const imageModel = () => process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';

  // Fähigkeiten des Bildmodells laut OpenRouter (z. B. wie viele Referenzbilder es annimmt), 1 h zwischengespeichert
  const capsCache = new Map();
  async function imageModelCaps(id) {
    const hit = capsCache.get(id);
    if (hit && Date.now() - hit.at < 3600e3) return hit.caps;
    let caps = { maxReferences: 3 };
    try {
      const r = await fetch('https://openrouter.ai/api/v1/images/models');
      const m = (await r.json()).data?.find((x) => x.id === id);
      const max = m?.supported_parameters?.input_references?.max;
      if (Number.isInteger(max)) caps = { maxReferences: max };
    } catch { /* Standardwert behalten */ }
    capsCache.set(id, { at: Date.now(), caps });
    return caps;
  }

  app.get('/api/config', async (_req, res) => {
    const stylize = !!process.env.OPENROUTER_API_KEY;
    res.json({
      chat: !!(anthropic || process.env.ANTHROPIC_API_KEY),
      stylize,
      chatModel: model(),
      imageModel: imageModel(),
      maxReferences: stylize ? (await imageModelCaps(imageModel())).maxReferences : 0,
    });
  });

  // Referenzfotos (Wikidata/Commons) für Wahrzeichen der illustrierten Stadtkarte
  app.post('/api/references', async (req, res) => {
    const { qids } = req.body || {};
    if (!Array.isArray(qids)) return res.status(400).json({ error: 'qids (Liste von Wikidata-IDs) fehlt.' });
    try {
      res.json({ references: await fetchReferences(qids) });
    } catch (err) {
      res.status(502).json({ error: `Wikidata/Commons nicht erreichbar: ${err.message || err}` });
    }
  });

  app.post('/api/session', (_req, res) => {
    const id = crypto.randomUUID();
    sessions.set(id, createSession());
    res.json({ id });
  });

  // Manuelle Änderungen aus der Oberfläche beim Server nachziehen, damit der Agent den aktuellen Stand kennt
  app.patch('/api/session/:sid/layers/:lid', (req, res) => {
    const l = sessions.get(req.params.sid)?.layers.get(req.params.lid);
    if (!l) return res.status(404).json({ error: 'Ebene nicht gefunden.' });
    const { color, fill_opacity, visible, group_colors, name } = req.body || {};
    const HEX = /^#[0-9a-fA-F]{6}$/;
    if (typeof name === 'string' && name.trim()) l.name = name.trim();
    if (HEX.test(color)) l.color = color;
    if (typeof fill_opacity === 'number') l.fillOpacity = Math.min(1, Math.max(0, fill_opacity));
    if (typeof visible === 'boolean') l.visible = visible;
    if (group_colors && typeof group_colors === 'object') {
      for (const [k, v] of Object.entries(group_colors)) if (HEX.test(v)) l.groupColors[k] = v;
    }
    res.json({ ok: true });
  });

  app.delete('/api/session/:sid/layers/:lid', (req, res) => {
    const ok = sessions.get(req.params.sid)?.layers.delete(req.params.lid);
    res.status(ok ? 200 : 404).json({ ok: !!ok });
  });

  app.post('/api/chat', async (req, res) => {
    const { sessionId, message } = req.body || {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Nachricht fehlt.' });
    const client = anthropic || (process.env.ANTHROPIC_API_KEY ? new Anthropic() : null);
    if (!client) return res.status(400).json({ error: 'ANTHROPIC_API_KEY fehlt. Bitte in der Datei .env eintragen und den Server neu starten.' });

    let session = sessions.get(sessionId);
    if (!session) { session = createSession(); sessions.set(sessionId || crypto.randomUUID(), session); }
    // (unbekannte Sitzungs-ID, z. B. nach Server-Neustart: neue Sitzung unter derselben ID anlegen)
    session.changes = newChanges();
    session.history.push({ role: 'user', content: message });

    try {
      let reply = '';
      for (let round = 0; round < 10; round++) {
        const resp = await client.messages.create({
          model: model(),
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          tools: toolDefinitions,
          messages: session.history,
        });
        session.history.push({ role: 'assistant', content: resp.content });
        reply = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (resp.stop_reason !== 'tool_use') break;

        const calls = resp.content.filter((b) => b.type === 'tool_use');
        const results = [];
        for (const call of calls) {
          try {
            const out = await runTool(session, call.name, call.input);
            results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
          } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: String(err.message || err) });
          }
        }
        session.history.push({ role: 'user', content: results });
        if (round === 9) reply = reply || 'Abgebrochen: zu viele Werkzeugrunden.';
      }

      const { upsert, remove, view } = session.changes;
      res.json({
        reply,
        upsert: [...upsert].map((id) => session.layers.get(id)).filter(Boolean).map(publicLayer),
        remove: [...remove],
        view,
      });
    } catch (err) {
      // Verlauf zurücksetzen, falls er durch den Fehler inkonsistent wäre (offener tool_use ohne Ergebnis)
      const last = session.history[session.history.length - 1];
      if (last?.role === 'assistant') session.history.pop();
      res.status(500).json({ error: `Fehler im Agenten: ${err.message || err}` });
    }
  });

  // Karte per Bildmodell (Nano Banana / Gemini über OpenRouter) stylisieren
  app.post('/api/stylize', async (req, res) => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return res.status(400).json({ error: 'OPENROUTER_API_KEY fehlt. Bitte in der Datei .env eintragen und den Server neu starten.' });
    const { image, prompt, aspect_ratio, references = [] } = req.body || {};
    const IMG = /^data:image\/\w+;base64,.+$/;
    if (!IMG.test(image || '') || !prompt) return res.status(400).json({ error: 'Bild (Data-URL) und Prompt sind erforderlich.' });
    if (!Array.isArray(references) || references.length > 13 || !references.every((r) => IMG.test(r))) return res.status(400).json({ error: 'Referenzbilder müssen Data-URLs sein (max. 13).' });

    const model = imageModel();
    try {
      const r = await fetch('https://openrouter.ai/api/v1/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'Kartenwerkstatt' },
        body: JSON.stringify({
          model,
          prompt,
          // Bild 1 ist die Karte, danach optionale Referenzfotos
          input_references: [image, ...references].map((url) => ({ type: 'image_url', image_url: { url } })),
          // Seitenverhältnis des (aufgefüllten) Ausschnitts, damit das Modell nicht auf ein anderes Format ausweicht
          ...(/^\d{1,2}:\d{1,2}$/.test(aspect_ratio || '') && { aspect_ratio }),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: `OpenRouter-Fehler ${r.status}: ${data.error?.message || 'unbekannt'}` });
      const img = data.data?.[0];
      if (!img?.b64_json) return res.status(422).json({ error: 'Das Modell lieferte kein Bild.' });
      res.json({ image: `data:${img.media_type || 'image/png'};base64,${img.b64_json}`, model });
    } catch (err) {
      res.status(502).json({ error: `OpenRouter nicht erreichbar: ${err.message || err}` });
    }
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`Kartenwerkstatt läuft auf http://localhost:${port}`);
    if (!process.env.ANTHROPIC_API_KEY) console.log('Hinweis: ANTHROPIC_API_KEY fehlt (Chat deaktiviert) – siehe .env.example');
    if (!process.env.OPENROUTER_API_KEY) console.log('Hinweis: OPENROUTER_API_KEY fehlt (Stylisieren deaktiviert) – siehe .env.example');
  });
}
