# Architektur

Technische Dokumentation der Kartenwerkstatt: Aufbau, Datenfluss, Schnittstellen und Erweiterungspunkte. Für Installation und Bedienung siehe [README](../README.md).

## Überblick

```
Browser (public/)                         Server (server.js, lib/)                 Externe Dienste
─────────────────                         ────────────────────────                 ───────────────
Chat ───────── POST /api/chat ──────────▶ Agent-Schleife ── messages.create ─────▶ Anthropic (Claude)
                                            │  ▲
                                            ▼  │ tool_use / tool_result
                                          runTool (lib/tools.js)
                                            ├─ geocode ──────────────────────────▶ Nominatim
                                            ├─ isochrone ────────────────────────▶ Valhalla
                                            └─ find_features ────────────────────▶ Overpass
Karte (MapLibre) ◀── Ebenen (GeoJSON) ────┘   geo_op, style_layer … (turf.js, lokal)

Basiskarte ◀───────────────────────────────────────────────────────────────────── OpenFreeMap / OSM-Kacheln

Stylisieren ── POST /api/stylize ───────▶ Weiterleitung ── POST /api/v1/images ──▶ OpenRouter → Gemini
```

Der Server ist zustandsbehaftet, aber ohne Datenbank: Sitzungen liegen in einer `Map` im Arbeitsspeicher. Das Frontend braucht keinen Build-Schritt, MapLibre GL kommt vom CDN (unpkg, Version 4.7.1).

## Dateien

| Datei | Inhalt |
|---|---|
| `server.js` | Express-App (`createApp`), Systemprompt, Agent-Schleife, Endpoint fürs Stylisieren |
| `lib/geo.js` | Zugriff auf Nominatim, Valhalla und Overpass, OSM-Kategorien (`CATEGORIES`), Untertyp-Namen (`SUBTYPE_LABELS`), Tag-Prüfung |
| `lib/wiki.js` | Referenzfotos: Wikidata (P18) → Commons-Vorschaubild mit Urheber und Lizenz |
| `lib/tools.js` | Werkzeugdefinitionen für Claude (`toolDefinitions`), deren Ausführung (`runTool`), Sitzungs- und Ebenenmodell |
| `public/index.html` | Layout: Chat, Karte, Seitenleiste mit den Tabs Ebenen, Export und Stylisieren |
| `public/app.js` | Gesamte Oberfläche: Karte, Basiskarten, Ebenen, Export, Stylisieren, illustrierte Stadtkarte |
| `public/style.css` | Styles |
| `test/app.test.js` | Tests mit `node:test`, alle externen Dienste über ein gemocktes `fetch` |

## Server

### Endpoints

| Methode und Pfad | Zweck |
|---|---|
| `GET /api/config` | Welche Funktionen aktiv sind (`chat`, `stylize`), welche Modelle genutzt werden und was das Bildmodell kann (`maxReferences`, `resolutions`, live von OpenRouter, 1 h zwischengespeichert) |
| `POST /api/session` | Neue Sitzung, liefert `{ id }` |
| `POST /api/chat` | `{ sessionId, message }` → `{ reply, upsert, remove, view }` |
| `PATCH /api/session/:sid/layers/:lid` | Manuelle Änderungen aus der Oberfläche (Name, Farbe, Deckkraft, Sichtbarkeit, Gruppenfarben) |
| `DELETE /api/session/:sid/layers/:lid` | Ebene entfernen |
| `POST /api/references` | `{ qids }` → `{ references: { Q…: { image, file, artist, license, url } } }`, Fotos als Data-URL |
| `POST /api/stylize` | `{ image, prompt, aspect_ratio?, references?, resolution? }` → `{ image, model }`, leitet an OpenRouter weiter |

Der Server lauscht nur auf `127.0.0.1`. Die Schlüssel verlassen den Server nie, der Browser sieht nur `/api/config`.

### Sitzung und Ebenen

```js
session = { layers: Map<id, layer>, counter, lastCenter, history, changes }
layer   = { id: 'L1', name, geojson, color, fillOpacity, visible, groupBy, groupColors }
```

- Ebenen-IDs zählen pro Sitzung hoch (`L1`, `L2`, …). Claude spricht Ebenen über diese IDs an.
- `lastCenter` ist der zuletzt gesetzte Standort. Werkzeuge ohne Ortsangabe nutzen ihn.
- Jedes Objekt hat `properties.name`, `properties.subtype` (z. B. „Museum“) und `osm_id`, Flächen zusätzlich `area_m2`.
- `changes` sammelt während einer Chat-Anfrage, welche Ebenen neu oder geändert (`upsert`) bzw. entfernt (`remove`) wurden und wohin die Karte zoomen soll (`view`). Die Antwort schickt genau diese Änderungen an den Browser.

### Agent-Schleife (`POST /api/chat`)

1. Die Nachricht kommt in `session.history`.
2. Bis zu 10 Runden `messages.create` mit Systemprompt, `toolDefinitions` und Verlauf (`max_tokens` 2000).
3. Bei `stop_reason: 'tool_use'` führt der Server alle Werkzeugaufrufe der Runde aus und hängt die Ergebnisse als `tool_result` an. Fehler gehen als `is_error` an Claude zurück, damit es reagieren kann.
4. Sonst ist der Text der letzten Antwort die Chat-Antwort.

Bricht ein Aufruf mit einem Fehler ab, entfernt der Server die letzte Assistenten-Nachricht aus dem Verlauf. Sonst bliebe ein `tool_use` ohne Ergebnis stehen, und jede weitere Anfrage der Sitzung würde scheitern.

Der Systemprompt legt fest: nur Zahlen aus Werkzeugergebnissen nennen, keinen Ort raten, Standard 15 Minuten zu Fuß, nach den Werkzeugen kurz zusammenfassen und Einschränkungen nennen.

### Werkzeuge

| Werkzeug | Wirkung | Dienst |
|---|---|---|
| `geocode` | Ort suchen oder „lat, lon“ lesen, als Standort setzen, Marker-Ebene anlegen | Nominatim |
| `isochrone` | Erreichbarkeitsflächen, Modus `pedestrian`/`bicycle`/`auto`, bis zu 4 Zeiten ≤ 60 min | Valhalla |
| `find_features` | OSM-Objekte als Ebene, per `category` oder eigenen `osm_tags`, innerhalb einer Ebene (`within_layer_id`, Flächen werden zugeschnitten) oder im Radius | Overpass |
| `geo_op` | `buffer`, `clip`, `subtract`, `keep_inside`, `keep_outside` | turf.js (lokal) |
| `style_layer` | Name, Farbe, Deckkraft, Sichtbarkeit, Gruppenfarben | lokal |
| `zoom_to_layer`, `remove_layer`, `list_layers` | Verwaltung | lokal |

Grenzen in `lib/tools.js`: Radius max. 5000 m, Suchfläche max. 30 km Diagonale, Gebäude max. 1500 m Radius bzw. 4 km Diagonale, max. 6000 Objekte je Ebene.

OSM-Tags werden mit einem regulären Ausdruck geprüft (`validateTags`), bevor sie in eine Overpass-Abfrage kommen. Das verhindert, dass über den Chat beliebiger Overpass-Code eingeschleust wird. Der Test „keine Query-Injection“ deckt das ab.

### Stylisieren (`POST /api/stylize`)

Der Endpoint nimmt eine Data-URL und einen Prompt, ruft `https://openrouter.ai/api/v1/images` mit `model`, `prompt`, `input_references` (das Bild) und optional `aspect_ratio` auf und gibt das erste Bild aus `data[]` als Data-URL zurück. `aspect_ratio` wird nur im Format `Zahl:Zahl` weitergereicht. Die gesamte Bildverarbeitung (Auffüllen, Zuschneiden, Beschriften) passiert im Browser.

## Frontend

### Karte und Basiskarten

- MapLibre startet mit einem leeren Stil, der nur eine Hintergrundebene `bg` enthält. Die Basiskarte wird darübergelegt, die Analyse-Ebenen darüber.
- **Hell/Dunkel** sind die OpenFreeMap-Stile `positron` und `dark`. `setBasemap` lädt das Stil-JSON (mit Cache), übernimmt Schriften und Sprites, fügt Quellen und Ebenen mit dem Präfix `bm-` ein und setzt die Hintergrundfarbe des Stils auf `bg`. Ist OpenFreeMap nicht erreichbar, schaltet die Karte auf OSM um.
- **OpenStreetMap** ist eine einfache Rasterquelle, **Ohne** zeigt nur den weißen Hintergrund.
- Analyse-Ebenen bestehen je aus drei MapLibre-Ebenen (`L1-fill`, `L1-line`, `L1-circle`). `reorder` legt Flächen unter Linien unter Punkte.

### Export

1. `frameRect` berechnet den Ausschnitt (90 % der Kartenfläche im Seitenverhältnis des Formats). Der blaue Rahmen zeigt ihn an. Seine Abdunklung bleibt durch `overflow: hidden` auf `#mapwrap` auf der Karte.
2. `grabMap(targetWidth)` setzt die Pixeldichte der Karte kurz hoch (`map.setPixelRatio`), wartet auf `idle`, kopiert die Zeichenfläche und setzt die Pixeldichte zurück. Ziel sind 300 dpi für das Papierformat.
3. Grenzen: `maxCanvasSize` der Karte ist auf 8192 × 8192 angehoben (MapLibre-Standard 4096). Dazu kommen die WebGL-Grenzen des Browsers.
4. `grabFrame` schneidet den Ausschnitt aus, `composeExport` zeichnet Titel, Maßstabsleiste, Nordpfeil, Legende und Quellenhinweis darüber. Alle Größen skalieren mit `u = Breite / 1200`, damit das Layout bei jeder Auflösung gleich aussieht.

Der Maßstab berechnet sich aus Zoomstufe und Breitengrad (Web-Mercator-Meter pro Pixel) und der Papierbreite des Formats.

### Seitenverhältnis bei Gemini

Gemini erzeugt nur feste Formate, und deren Pixelmaße weichen vom Namen ab („4:3“ = 1184 × 864 px). Damit die Karte nicht verzerrt wird:

1. `padToRatio` wählt das Format, das dem Ausschnitt am nächsten liegt (gemessen an den echten Pixelmaßen in `IMAGE_RATIOS`), und füllt den Ausschnitt mit weißem Rand darauf auf.
2. Das Format geht als `aspect_ratio` mit, und der Prompt bekommt den Hinweis, den Rand weiß zu lassen.
3. `cropResult` schneidet aus dem Ergebnis den Bereich des ursprünglichen Ausschnitts und bringt ihn exakt auf dessen Seitenverhältnis.

`stylizeCanvas` bündelt diese Schritte und wird von beiden Stylisier-Modi genutzt.

### Illustrierte Stadtkarte

```
collectPois ─▶ loadReferences ─▶ buildIlluInput ─▶ stylizeCanvas ─▶ (drawCredits | Straßennamen + drawIlluOverlay)
                                  ├ renderTemplate
                                  ├ drawIlluOverlay (nur „aus einem Guss“)
                                  └ composeIlluPrompt
```

1. **`collectPois`**: Punkte mit Namen aus sichtbaren Ebenen, die im Ausschnitt liegen (Standort-Marker und Doppelte ausgenommen), mit Typ, Wikidata-ID und Grundriss (`poiFootprint`). Den Grundriss liefert `find_features` für Sehenswürdigkeiten aus OSM (`out geom`, Fläche bis 40 000 m², als `properties.footprint`). Fehlt er, nimmt die App für Gebäude-Typen das Gebäude der Vektorkarte, in dem der Punkt liegt. OpenFreeMap fasst Häuser zu Multipolygonen zusammen, daher zählt nur das Teilpolygon mit dem Punkt; Umrisse über 30 % des Ausschnitts werden verworfen. Sie werden in Lesereihenfolge nummeriert, damit man sie in der Legende schnell findet. Höchstens 30.
2. **`loadReferences`**: Für Gebäude-Typen (`REF_TYPES`: Kirche, Burg, Stadttor, Museum …) mit Wikidata-ID holt `/api/references` die Fotos. Es werden höchstens so viele, wie das Modell neben der Vorlage annimmt (`maxReferences − 1`).
3. **`grabVectorFrame`**: Rendert den Ausschnitt der Vektor-Basiskarte nur mit ausgewählten Ebenen, optional mit anderen Textfarben, und stellt danach alles wieder her. Ist gerade keine Vektorkarte aktiv, wird kurz auf „Hell“ umgeschaltet. Darauf bauen auf:
   - **`renderTemplate`**: Straßen, Wasser, Grün und Gebäude ohne Beschriftung, optional mit Straßen- und Gewässernamen (`isNameLayer`), Grundrisse der Wahrzeichen sandfarben mit brauner Kontur, POIs ohne Grundriss als rote Punkte (nicht im Modus „aus einem Guss“ mit Nummern).
   - **`renderNameLabels`**: nur die Namen, auf transparentem Grund, zum Darüberlegen im Modus „exakt“.
4. **`buildIlluInput`**: Im Modus „aus einem Guss“ wird `drawIlluOverlay` schon auf die Vorlage angewendet. Nummern und Seitenleiste stehen so im Bild, das Gemini bekommt.
5. **`composeIlluPrompt`**: Textregel je nach Modus, Stil, Lagetreue, Ort mit Anweisung zur örtlichen Bauweise, Zuordnung der Referenzfotos (Bild 2 … n), je POI Typ und Lage in Prozent, bei Wahrzeichen die Ausdehnung des Grundrisses mit der Anweisung, genau darauf zu zeichnen. Im Modus „aus einem Guss“ werden die Lagen auf die Gesamtbreite inklusive Seitenleiste umgerechnet (`mapFrac`).
6. **`stylizeCanvas`**: wie oben, mit Referenzbildern und im Modus „aus einem Guss“ mit `resolution: '2K'`, wenn das Modell es kann.
7. **`refineLandmark`** (Option „Wahrzeichen genau platzieren“, höchstens 6): Wahrzeichen mit Foto und Grundriss bekommen ihr Foto nicht im ersten Durchgang (dort nur schlichtes Gebäude, Bildnummern der übrigen Fotos rücken nach), sondern danach einzeln: quadratischer Ausschnitt um den Grundriss (3 × Grundriss, 20–50 % der Kartenbreite, etwas nach oben versetzt für Türme), Grundriss magenta umrandet, `stylizeCanvas` in 1K mit nur diesem Foto, Rückweg mit 6 % weichem Rand (`filter: blur` als Maske). Danach folgt erst die Beschriftung bzw. der Quellenhinweis mit allen Fotos.
8. **Nachbearbeitung**: „aus einem Guss“ nur `drawCredits`, „exakt“ Straßennamen darüberlegen und `drawIlluOverlay` (Nummern mit Ausweichlogik neben den Orten bzw. knapp außerhalb des Grundrisses, nie auf einem anderen Grundriss, Seitenleiste, Quellen).

**Was die Tests im Browser gezeigt haben** (Deventer, Altstadt):

- Stehen die POI-Namen im Prompt, schreibt Gemini sie trotz Textverbot ins Bild. Im Modus „exakt“ bekommt es deshalb nur Typen.
- Nano Banana 2 hält sich in 2K eng an die Vorlage und übernimmt rote Markierungspunkte als Bildinhalt. Im Modus „aus einem Guss“ dienen deshalb die Nummern als Anker.
- Mit Ortsangabe zeichnet Gemini die örtliche Bauweise (Backstein, Ziegeldächer), ohne sie generische Häuser.
- Referenzfotos verbessern die Ähnlichkeit sichtbar (Turm der Lebuinuskerk), die Lage der Zeichnung ist aber nicht immer genau.
- Mit Grundrissen sitzen kleine Wahrzeichen (De Waag, Speelgoedmuseum) auf ihrem Platz. Die Lebuinuskerk landete trotzdem eine Kirchenlänge daneben auf dem freien Kirchhof. Ohne die Multipolygon-Prüfung war jedes Haus der Vorlage sandfarben und Gemini platzierte frei.
- Mit dem zweiten Durchgang pro Wahrzeichen deckten sich alle Grundrisse aus der Vorlage mit den Zeichnungen (geprüft durch Überlagern), Lebuinuskerk und EICAS eingeschlossen. Die Nahtstellen sind nicht zu sehen. Zwei Wahrzeichen kosteten etwa 25 Sekunden zusätzlich.
- Im Modus „aus einem Guss“ sind einzelne Fehler möglich: eine Nummer doppelt, Gewässernamen zusammengezogen.

## Entscheidungen

| Thema | Entscheidung | Grund |
|---|---|---|
| Bildmodell | Gemini über OpenRouter statt direkt bei Google | Ein Schlüssel, Abrechnung und Modellwechsel an einer Stelle |
| OpenRouter-Schnittstelle | `/api/v1/images` statt Chat Completions | Eigene Bild-API mit `input_references` und `aspect_ratio` |
| Chat | weiter Claude über das Anthropic-SDK | Werkzeugaufrufe und Regeltreue laufen stabil, Umbau nicht nötig |
| Basiskarte | OpenFreeMap statt CARTO | CARTO liefert ohne Schlüssel nur noch Kacheln mit Wasserzeichen |
| Export | höhere Pixeldichte statt Bildschirmfoto | Bildschirmauflösung ergab für A3 nur rund 1260 px Breite |
| Beschriftung bei Bildmodellen | Zwei Modi: „aus einem Guss“ (Gemini letert alles) und „exakt“ (App setzt Text) | Gezeichnete Schrift wirkt einheitlich, ist aber fehleranfällig; die Wahl hängt vom Zweck ab |
| Quellenhinweis | immer von der App | Muss buchstabengenau stimmen (OSM, Lizenzen der Fotos) |
| Referenzfotos | Server lädt sie und schickt Data-URLs | Wikimedia verlangt einen User-Agent; ob OpenRouter oder Google die URLs abrufen dürfen, ist unsicher |
| Fähigkeiten des Bildmodells | live von OpenRouter (`/api/v1/images/models`) | Grenzen wie die Zahl der Eingabebilder unterscheiden sich je Modell (3 bis 14) |

## Tests

```bash
npm test
```

`test/app.test.js` ersetzt `globalThis.fetch` durch einen Mock für Nominatim, Valhalla, Overpass und OpenRouter. Claude wird als Objekt mit `messages.create` an `createApp({ anthropic })` übergeben. Abgedeckt sind:

- die Analysekette Geocoding → Isochrone → Grünflächen zugeschnitten → Haltestellen gefiltert,
- Radiussuche, Puffer und `keep_outside`,
- `style_layer`, `remove_layer` und Fehler bei unbekannten Ebenen,
- die Tag-Prüfung gegen Query-Injection,
- die Agent-Schleife mit Werkzeugaufruf über HTTP,
- Fehlermeldungen ohne Schlüssel und das Stylisieren inklusive Request an OpenRouter (Referenzbilder, Auflösung, Seitenverhältnis),
- Referenzfotos: Wikidata → Commons mit Urheber und Lizenz, Wikidata-IDs aus OSM.

Die Bildverarbeitung im Browser (Export, Auffüllen, Zuschneiden, illustrierte Stadtkarte) hat keine automatischen Tests. Sie wurde von Hand im Browser geprüft.

## Erweitern

| Vorhaben | Wo |
|---|---|
| Neue POI-Kategorie | `CATEGORIES` in `lib/geo.js`, deutsche Untertyp-Namen in `SUBTYPE_LABELS`. Das Werkzeug `find_features` übernimmt die Liste automatisch. |
| Neues Werkzeug für den Chat | Definition in `toolDefinitions` und Fall in `runTool` (`lib/tools.js`), bei Bedarf Hinweis im Systemprompt (`server.js`) |
| Neue Stilvorlage zum Umstylen | `PRESETS` in `public/app.js` |
| Neue Stilvorlage für die Stadtkarte | `ILLU_PRESETS` in `public/app.js` |
| Weitere Gebäudetypen für Referenzfotos | `REF_TYPES` in `public/app.js` |
| Anderes Bildmodell | `OPENROUTER_IMAGE_MODEL` in `.env`. Liefert es andere Formate als Gemini, `IMAGE_RATIOS` anpassen. |
| Höhere Exportauflösung | `EXPORT_DPI`, `MAX_CANVAS` und `maxCanvasSize` in `public/app.js` |

Naheliegende nächste Schritte: Sitzungen speichern, GeoJSON-Export der Ebenen (etwa für QGIS), Analysen per Link teilen, ein kurzer Bericht mit Zahlen und Quellen zur Karte.
