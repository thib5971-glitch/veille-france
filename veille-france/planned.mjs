// Manifestations prévues : agendas militants Démosphère (iCal) + annonces repérées dans la presse.
import { findOrgs } from "./manif.mjs";

const UA = "VeilleFrance/1.0 (carte d'actualité ; github actions)";
const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’ʼ]/g, "'");
const low = s => norm(s).toLowerCase();
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

export const DEMOSPHERES = ["paris", "toulouse", "lille", "rennes", "nice", "gironde", "gard", "carcassonne", "ariege", "tarn", "berry", "04", "05",
  "poitiers", "strasbourgfurieuse", "lot", "sarthe", "dunkerque", "pyrenees", "limoges", "63", "aveyron"];

// ce qui ressemble à une manif (et pas à une réunion, un atelier, une projection…)
const IS_DEMO = /\b(manif\w*|rassemblement\w*|marche\b|marche (blanche|pour|contre|des)|cortege|defile|mobilisation|greve|piquet|blocage|blocus|die-in|sit-in|chaine humaine|veillee|vigile|occupation|action (contre|pour|devant)|tractage devant|convergence|convoi)\b/;
const NOT_DEMO = /\b(permanence|reunion|atelier|projection|conference|concert|repair|cafe|formation|assemblee generale|soiree|festival|debat|lecture|brunch|gouter|apero|cine|film|expo|vernissage|jam|scene ouverte|initiation|cours de|install party|vide|braderie|balade|visite|club|rencontre avec|presentation|table ronde|fete|bal |karaoke)\b/;
export const looksLikeDemo = t => IS_DEMO.test(low(t)) && !NOT_DEMO.test(low(t));

/* ---------- Dates ---------- */
function parisOffsetMs(utcMs) {
  const d = new Date(utcMs);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
export function parisTime(y, mo, d, h = 12, mi = 0) { const guess = Date.UTC(y, mo, d, h, mi); return guess - parisOffsetMs(guess); }
function icsDate(v) {
  const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/); if (!m) return NaN;
  if (m[7]) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0);
  return parisTime(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
}
const MOIS = { janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11 };
const JOURS = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 };
// date future citée dans un texte d'annonce, relative à la date de publication
export function futureDate(text, pub) {
  const t = low(text), base = new Date(pub + parisOffsetMs(pub));
  const by = base.getUTCFullYear(), bm = base.getUTCMonth(), bd = base.getUTCDate(), bw = base.getUTCDay();
  const hm = t.match(/(?:a|des|vers|rendez-vous a|rdv a|depart a|a partir de)\s+(\d{1,2})\s?h\s?(\d{2})?/);
  const okH = !!(hm && +hm[1] >= 6 && +hm[1] <= 23), H = okH ? +hm[1] : 12, MI = okH && hm[2] ? +hm[2] : 0, hasTime = okH;
  let m = t.match(/\b(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\b/);
  if (m) {
    let y = by, mo = MOIS[m[2]], d = +m[1];
    if (mo < bm - 1) y++;
    const ts = parisTime(y, mo, d, H, MI);
    return ts > pub - 12 * 3600e3 ? { ts, hasTime } : null;
  }
  if (/\bdemain\b/.test(t)) return { ts: parisTime(by, bm, bd + 1, H, MI), hasTime };
  if ((m = t.match(/\b(ce|cette|le|prochain|ce prochain)?\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(\s+prochain)?\b/))) {
    let delta = (JOURS[m[2]] - bw + 7) % 7; if (delta === 0 && (m[3] || !/\b(aujourd'hui|ce matin|cet apres-midi|ce soir)\b/.test(t))) delta = m[3] ? 7 : 0;
    return { ts: parisTime(by, bm, bd + delta, H, MI), hasTime };
  }
  return null;
}
// annonce plutôt que compte rendu
export const ANNOUNCE = /\b(appel(le|lent|ent)? a (manifester|se rassembler|la greve|une|un)|appel a|appellent|prevue?s?|aura lieu|se tiendra|organise(ra|ront)?|rendez-vous|rdv|demain|prochain|journee (nationale )?de mobilisation|journee d'action|preavis|va manifester|vont manifester|manifesteront|se rassembleront|defileront)\b/;

/* ---------- iCal ---------- */
function parseICS(txt) {
  const lines = txt.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out = []; let cur = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") cur = {};
    else if (l === "END:VEVENT") { if (cur) out.push(cur); cur = null; }
    else if (cur) { const i = l.indexOf(":"); if (i < 0) continue; const k = l.slice(0, i).split(";")[0].toUpperCase(); cur[k] = l.slice(i + 1).replace(/\\n/g, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\"); }
  }
  return out;
}

export async function fetchPlanned({ now, communes, geocode, locate, log = () => {}, instances = DEMOSPHERES }) {
  const res = [], ok = [], bad = [];
  const nearestCommune = (lat, lon) => {
    let best = null, bd = Infinity;
    for (const [nom, dep, la, lo, pop] of communes) { const d = (la - lat) ** 2 + ((lo - lon) * .7) ** 2 - (pop > 20000 ? 1e-5 : 0); if (d < bd) { bd = d; best = { nom, dep }; } }
    return best;
  };
  for (const inst of instances) {
    const url = `https://${inst}.demosphere.net/events.ics`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { bad.push(inst); continue; }
      const evs = parseICS(await r.text()); ok.push(inst);
      for (const e of evs) {
        const title = (e.SUMMARY || "").trim(); if (!title || !looksLikeDemo(title)) continue;
        const start = icsDate(e.DTSTART || ""); if (isNaN(start) || start < now - 6 * 3600e3 || start > now + 21 * 864e5) continue;
        const end = icsDate(e.DTEND || ""), loc = (e.LOCATION || "").trim();
        let lat = null, lon = null, place = null, dep = null, precise = false;
        if (e.GEO) { const [a, b] = e.GEO.split(/[;,]/).map(Number); if (isFinite(a) && isFinite(b) && a > 40 && a < 52) { lat = a; lon = b; precise = true; } }
        const g = locate(loc) || locate(title);
        if (lat != null) { const c = g && !g.area ? { nom: g.nom, dep: g.dep } : nearestCommune(lat, lon); place = c?.nom; dep = c?.dep; }
        else if (g) { place = g.nom; dep = g.dep; lat = g.lat; lon = g.lon; if (loc && !g.area) { const p = await geocode(loc.split(",")[0], g.nom, { lat: g.lat, lon: g.lon }); if (p) { lat = p.lat; lon = p.lon; precise = true; } } }
        const desc = (e.DESCRIPTION || "").slice(0, 2000);
        res.push({ id: "d" + hash(e.UID || e.URL || title + start), title, start, end: isNaN(end) ? null : end, hasTime: /T\d{4}/.test(e.DTSTART || ""),
          place, dep, lat, lon, precise, where: loc.slice(0, 120) || null, orgs: findOrgs(title + " " + desc),
          sources: [{ src: `Démosphère ${inst}`, url: (e.URL && /^https?:/.test(e.URL)) ? e.URL : `https://${inst}.demosphere.net/` }], origin: "agenda" });
      }
    } catch { bad.push(inst); }
    await new Promise(r => setTimeout(r, 400));
  }
  log(`  agendas : ${ok.length} ok${bad.length ? `, ${bad.length} sans réponse (${bad.join(", ")})` : ""} · ${res.length} manifs prévues`);
  return { items: res, ok: ok.length, total: instances.length };
}

// fusionne une annonce (presse ou agenda) dans la liste en évitant les doublons même ville + même jour
export function mergePlanned(list, it) {
  const day = d => new Date(d + parisOffsetMs(d)).toISOString().slice(0, 10);
  const w = s => new Set(low(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(x => x.length > 3));
  const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
  const ex = list.find(p => p.id === it.id || (p.place && it.place && low(p.place) === low(it.place) && day(p.start) === day(it.start) && (jac(w(p.title), w(it.title)) >= .2 || (p.orgs.length && it.orgs.some(o => p.orgs.some(q => q.sigle === o.sigle))))));
  if (!ex) { list.push(it); return true; }
  for (const s of it.sources) if (!ex.sources.some(x => x.url === s.url)) ex.sources.push(s);
  ex.sources = ex.sources.slice(0, 10);
  for (const o of it.orgs) if (!ex.orgs.some(x => x.sigle === o.sigle)) ex.orgs.push(o);
  if (!ex.hasTime && it.hasTime) { ex.start = it.start; ex.hasTime = true; }
  if (!ex.precise && it.precise) Object.assign(ex, { lat: it.lat, lon: it.lon, precise: true, where: it.where || ex.where });
  return false;
}
