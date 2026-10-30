// Referenzfotos für Wahrzeichen: Wikidata (Bild-Eigenschaft P18) → Wikimedia Commons (Vorschaubild, Urheber, Lizenz)
import { UA, fetchJson } from './geo.js';

const QID = /^Q\d+$/;
const MAX_QIDS = 14;
const THUMB_WIDTH = 640;

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function toDataUrl(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Commons antwortete mit ${r.status}`);
  const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
}

// Liefert je Q-ID { image (Data-URL), file, artist, license, url } für alle, zu denen es ein Foto gibt
export async function fetchReferences(qids) {
  const ids = [...new Set((qids || []).filter((q) => QID.test(q)))].slice(0, MAX_QIDS);
  if (!ids.length) return {};

  const wd = await fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&ids=${ids.join('|')}`, {}, 30000);
  const files = {};
  for (const [q, e] of Object.entries(wd.entities || {})) {
    const file = e.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (file) files[q] = file;
  }
  if (!Object.keys(files).length) return {};

  const titles = Object.values(files).map((f) => `File:${f}`).join('|');
  const cm = await fetchJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo'
    + `&iiprop=url|extmetadata&iiextmetadatafilter=Artist|LicenseShortName&iiurlwidth=${THUMB_WIDTH}&titles=${encodeURIComponent(titles)}`, {}, 30000);
  const info = {};
  // Commons normalisiert Titel (z. B. Unterstriche); über "normalized" zurück auf den Dateinamen abbilden
  const norm = Object.fromEntries((cm.query?.normalized || []).map((n) => [n.to, n.from]));
  for (const page of Object.values(cm.query?.pages || {})) {
    const ii = page.imageinfo?.[0];
    if (!ii?.thumburl) continue;
    const title = norm[page.title] || page.title;
    info[title.replace(/^File:/, '')] = {
      thumb: ii.thumburl,
      url: ii.descriptionurl,
      artist: stripHtml(ii.extmetadata?.Artist?.value) || 'unbekannt',
      license: stripHtml(ii.extmetadata?.LicenseShortName?.value) || 'siehe Commons',
    };
  }

  const out = {};
  await Promise.all(Object.entries(files).map(async ([q, file]) => {
    const i = info[file];
    if (!i) return;
    try { out[q] = { image: await toDataUrl(i.thumb), file, artist: i.artist, license: i.license, url: i.url }; } catch { /* Foto überspringen */ }
  }));
  return out;
}
