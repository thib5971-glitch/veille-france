// Veille France – récupère les flux RSS, localise, classe, regroupe et envoie les alertes.
// Lancé toutes les 10 minutes par GitHub Actions (voir .github/workflows/update.yml).
import fs from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

const ROOT = new URL("..", import.meta.url);
const P = f => new URL(f, ROOT);
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };

const cfg = await readJSON(P("config.json"), {});
const FEEDS = process.env.FEEDS_OVERRIDE ? await readJSON(process.env.FEEDS_OVERRIDE, []) : cfg.feeds || [];
const KEEP_MS = (cfg.keepDays || 7) * 864e5;
const NOW = Date.now();
const log = (...a) => console.log(...a);

/* ---------- Texte ---------- */
const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’ʼ`]/g, "'");
const low = s => norm(s).toLowerCase();
const key = s => low(s).replace(/['-]/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const stripHtml = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

/* ---------- Géographie : 35 000 communes + départements ---------- */
async function loadCommunes() {
  const file = process.env.COMMUNES_FILE ? new URL("file://" + process.env.COMMUNES_FILE) : P("data/communes.json");
  let list = await readJSON(file, null);
  if (!list) {
    log("Téléchargement des communes depuis geo.api.gouv.fr…");
    const r = await fetch("https://geo.api.gouv.fr/communes?fields=nom,codeDepartement,centre,population&format=json", { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error("geo.api.gouv.fr " + r.status);
    list = (await r.json()).filter(c => c.centre).map(c => [c.nom, c.codeDepartement, +c.centre.coordinates[1].toFixed(4), +c.centre.coordinates[0].toFixed(4), c.population || 0]);
    await fs.writeFile(P("data/communes.json"), JSON.stringify(list));
    log(`${list.length} communes enregistrées.`);
  }
  return list;
}
const communes = await loadCommunes();
const deps = await readJSON(P("departements.json"), []);
const depName = Object.fromEntries(deps.map(d => [d.code, d.nom]));
const OUTREMER = { "971": "Guadeloupe", "972": "Martinique", "973": "Guyane", "974": "La Réunion", "976": "Mayotte" };

const CITY = new Map(); // clé normalisée -> [{nom, dep, lat, lon, pop}]
for (const [nom, dep, lat, lon, pop] of communes) {
  const k = key(nom); if (!CITY.has(k)) CITY.set(k, []);
  CITY.get(k).push({ nom, dep, lat, lon, pop });
}
const pickHomonym = arr => {
  const metro = arr.filter(c => !OUTREMER[c.dep]).sort((a, b) => b.pop - a.pop);
  const all = [...arr].sort((a, b) => b.pop - a.pop);
  return metro[0] && metro[0].pop >= all[0].pop * 0.1 ? metro[0] : all[0];
};
const AREA = new Map(); // départements et régions
deps.forEach(d => AREA.set(key(d.nom), { nom: d.nom, dep: d.code, lat: d.c[1], lon: d.c[0], area: true }));
[["Île-de-France", "75", 48.75, 2.5], ["Bretagne", "35", 48.1, -2.9], ["Normandie", "14", 49.1, 0.2], ["Occitanie", "31", 43.7, 2.2],
 ["Alsace", "67", 48.3, 7.45], ["Provence", "13", 43.7, 5.6], ["Corse", "2A", 42.15, 9.1], ["Côte d'Azur", "06", 43.6, 7.0],
 ["Lorraine", "54", 48.8, 6.2], ["Auvergne", "63", 45.6, 3.1], ["Champagne", "51", 49.0, 4.1], ["Picardie", "80", 49.7, 2.6],
 ["Pays basque", "64", 43.3, -1.3], ["Camargue", "13", 43.55, 4.5]].forEach(([nom, dep, lat, lon]) => AREA.set(key(nom), { nom, dep, lat, lon, area: true }));
for (const [code, nom] of Object.entries(OUTREMER)) AREA.set(key(nom), { nom, dep: code, lat: null, lon: null, area: true });

// Mots capitalisés trop ambigus pour être pris comme commune sans contexte
const STOP = new Set(["police", "justice", "france", "mort", "plus", "sept", "cours", "bar", "pont", "orange", "vienne", "valence", "mars", "avril", "mai", "juin", "tribunal", "prison", "gendarmerie", "etat", "ville", "centre", "nord", "sud", "est", "ouest", "saint", "sainte", "lot", "ain", "var", "gard", "cher", "aube", "eure", "oise", "orne", "tarn", "allier", "loire", "rhone", "marne", "somme", "meuse", "dore", "aude", "nievre", "jura", "doubs", "manche", "landes", "vosges", "isere", "seine"]);
const CTX = new Set(["a", "au", "aux", "de", "du", "des", "en", "vers", "pres", "sur", "dans", "pour", "d", "l", "la", "le", "les"]);
const AREA_CTX = new Set(["en", "dans", "le", "la", "les", "l", "du", "de", "d", "des"]);

function locate(text) {
  if (!text) return null;
  const toks = [...text.matchAll(/[\p{L}\p{N}'’-]+/gu)].map(m => ({ raw: m[0], i: m.index }));
  let best = null;
  for (let s = 0; s < toks.length; s++) {
    for (let len = 4; len >= 1; len--) {
      if (s + len > toks.length) continue;
      let first = toks[s].raw.replace(/^(d|l|qu|jusqu)['’]/, "");
      if (!/^\p{Lu}/u.test(first)) continue;
      const phrase = [first, ...toks.slice(s + 1, s + len).map(t => t.raw)].join(" ");
      const k = key(phrase);
      const prevRaw = s > 0 ? low(toks[s - 1].raw) : "";
      const prev = toks[s].raw !== first ? low(toks[s].raw.split(/['’]/)[0]) : prevRaw;
      const end = toks[s + len - 1].i + toks[s + len - 1].raw.length;
      const after = text.slice(end, end + 6);
      let ctx = 0;
      if (CTX.has(prev)) ctx += 2;
      if (s === 0 && /^\s*[:,–-]/.test(after)) ctx += 2;
      if (/^\s*\((\d{2,3}|2A|2B)\)/.test(after)) ctx += 3;
      let cand = null;
      if (CITY.has(k)) {
        const c = pickHomonym(CITY.get(k));
        const single = len === 1;
        const ok = ctx > 0 ? (c.pop >= 300 || ctx >= 3) && !(single && STOP.has(k) && ctx < 3)
                           : c.pop >= 30000 && !STOP.has(k);
        if (ok) cand = { ...c, score: ctx * 2 + Math.log10(c.pop + 10) + len };
      }
      if (!cand && AREA.has(k) && (AREA_CTX.has(prev) || ctx >= 2)) {
        cand = { ...AREA.get(k), score: 1 + ctx };
      }
      if (cand && (!best || cand.score > best.score)) best = cand;
      if (cand) break; // le n-gramme le plus long gagne pour ce point de départ
    }
  }
  if (!best) { const m = text.match(/\((\d{2}|2A|2B|97\d)\)/); if (m && depName[m[1]]) { const d = deps.find(x => x.code === m[1]); best = { nom: d.nom, dep: d.code, lat: d.c[1], lon: d.c[0], area: true }; } }
  return best;
}

/* ---------- Gravité et type ---------- */
const R_CRIT = /\b(tue|tuee|tues|tuees|mort|morte|morts|mortes|meurtre\w*|homicide\w*|assassin\w*|abattu\w*|decede\w*|deces|cadavre|corps sans vie|attentat\w*|feminicide\w*|infanticide|perd la vie|ont perdu la vie|sans vie)\b/;
const R_GRAVE = /\b(blesse\w*|poignard\w*|coups? de couteau|couteau|fusillade\w*|tirs?|par balles?|balles?|griev\w*|viol|violee|violees|enlev\w*|sequestr\w*|incendie criminel|arme a feu|kalachnikov|pronostic vital|machette|arme blanche|lynch\w*|passage a tabac|tabasse\w*|urgence absolue)\b/;
const R_ELEVE = /\b(agress\w*|violences?|violent\w*|emeute\w*|rixe\w*|braquage\w*|braque\w*|affrontement\w*|interpell\w*|garde a vue|casseur\w*|mortier\w*|degradation\w*|vol a main armee|menace\w*|incendi\w*|refus d.obtemperer|narcotrafic\w*|trafic de drogue|reglement de comptes?|frappe\w*|cambriol\w*|home-jacking|car-jacking|guet-apens|caillasse\w*)\b/;
const NOISE = /\b(football|ligue 1|match|rugby|tennis|film|serie|cinema|bande-annonce|critique|livre|roman|horoscope|meteo|recette|bourse|cac 40|jeu video|playstation|netflix|podcast|exposition|concert|festival|anniversaire de la mort|il y a \d+ ans|proces de|condamne a|jugement|cour d'assises|en appel|requisitions?|mis en examen)\b/;
const FOREIGN = /\b(etats-unis|americain\w*|ukraine|ukrainien\w*|russie|russe\w*|gaza|israel\w*|liban\w*|iran\w*|syrie\w*|soudan|mexique|bresil|inde|chine|chinois|espagne|espagnol\w*|italie|italien\w*|allemagne|allemand\w*|belgique|belge\w*|suisse|royaume-uni|britannique\w*|londres|new york|texas|californie|afrique|algerie|maroc|tunisie|turquie|pakistan|afghanistan|venezuela|colombie|haiti|nigeria|congo|yemen|irak|cisjordanie)\b/;
const TYPES = [
  ["Terrorisme", /attentat|terroris/], ["Violences conjugales", /conjoint|compagne|compagnon|feminicide|ex-mari|ex-femme|epouse|violences conjugales/],
  ["Refus d'obtempérer, police", /refus d.obtemperer|policiers? (blesse|agresse|vise|percute)|gendarmes? (blesse|agresse|percute)/], ["Arme à feu", /fusillade|\btirs?\b|\bballes?\b|arme a feu|kalach|abattu/],
  ["Arme blanche", /couteau|poignard|machette|arme blanche/], ["Émeutes, manifs", /manif|emeute|casseur|blocus|mortier|affrontement|violences urbaines|lyceen/],
  ["Refus d'obtempérer, police", /refus d.obtemperer|policiers? (blesse|agresse|vise|percute)|gendarmes? (blesse|agresse|percute)/],
  ["Violences sexuelles", /\bviol\b|\bviolee|agression sexuelle/], ["Incendie", /incendi/],
  ["Trafic, règlement de comptes", /trafic|narco|reglement de compte|point de deal/], ["Agression", /agress|rixe|frapp|tabac|lynch|tabasse/],
  ["Braquage, vol", /braqu|vol a main|cambriol|jacking/]
];
const SEVW = { crit: 3, grave: 2, eleve: 1 };
function classify(title, desc) {
  const t = low(title), all = t + " " + low(desc);
  if (NOISE.test(t)) return null;
  let sev = null;
  if (R_CRIT.test(t)) sev = "crit"; else if (R_GRAVE.test(t)) sev = "grave"; else if (R_ELEVE.test(t)) sev = "eleve";
  else if (R_CRIT.test(all) || R_GRAVE.test(all)) sev = "eleve";
  if (!sev) return null;
  return { sev, type: (TYPES.find(([, r]) => r.test(all)) || ["Autre"])[0], foreign: FOREIGN.test(t) };
}

/* ---------- Regroupement des articles qui parlent du même fait ---------- */
const STOPW = new Set("le la les un une des de du d l a au aux et ou en dans sur pour par avec sans ce cette ces son sa ses leur leurs qui que quoi dont est sont a ont ete etre apres avant lors pres plus deux trois quatre cinq ans an homme femme jeune selon ce qu il elle ils elles on nous vous se ne pas y".split(" "));
const words = t => new Set(key(t).split(" ").filter(w => w.length > 2 && !STOPW.has(w)));
const jacc = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i || 1); };

/* ---------- Récupération ---------- */
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", processEntities: true, htmlEntities: true });
const txt = v => v == null ? "" : typeof v === "object" ? (v["#text"] ?? "") : String(v);
async function fetchText(url) {
  if (url.startsWith("file:")) return fs.readFile(new URL(url), "utf8");
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (VeilleFrance; +github actions)", "Accept": "application/rss+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}
function parseFeed(xml, feed) {
  const j = parser.parse(xml);
  let items = j?.rss?.channel?.item ?? j?.feed?.entry ?? j?.["rdf:RDF"]?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return items.map(it => {
    let link = it.link; if (Array.isArray(link)) link = link.find(l => !l["@rel"] || l["@rel"] === "alternate") || link[0];
    link = typeof link === "object" ? (link["@href"] || txt(link)) : txt(link);
    let title = stripHtml(txt(it.title)), src = txt(it.source) || feed.name;
    if (feed.splitSource || /news\.google\./.test(feed.url)) { const m = title.match(/^(.*)\s[-–]\s(.{2,60})$/); if (m) { title = m[1]; src = m[2]; } }
    const d = Date.parse(txt(it.pubDate) || txt(it.published) || txt(it.updated) || txt(it["dc:date"]));
    return { title, link: link.trim(), src, date: isNaN(d) ? NOW : Math.min(d, NOW), desc: stripHtml(txt(it.description) || txt(it.summary) || txt(it["content:encoded"])).slice(0, 500) };
  }).filter(i => i.title && i.link);
}

/* ---------- Programme principal ---------- */
const prev = await readJSON(P("data/data.json"), { events: [] });
const firstRun = !prev.updated || !prev.events.some(e => !e.seed);
let events = (prev.events || []).filter(e => NOW - e.date <= KEEP_MS);
const seenLinks = new Set(events.flatMap(e => e.articles.map(a => a.url)));
const seenTitles = new Set(events.flatMap(e => e.articles.map(a => key(a.t))));
const feedStatus = [];
const newIds = new Set(), escalated = new Set();

const results = await Promise.allSettled(FEEDS.map(f => fetchText(f.url).then(x => parseFeed(x, f))));
results.forEach((r, i) => {
  const f = FEEDS[i];
  if (r.status !== "fulfilled") { feedStatus.push({ name: f.name, ok: false, error: String(r.reason?.message || r.reason).slice(0, 80) }); return; }
  let kept = 0;
  for (const it of r.value) {
    if (NOW - it.date > KEEP_MS) continue;
    if (seenLinks.has(it.link) || seenTitles.has(key(it.title))) continue;
    const c = classify(it.title, it.desc); if (!c) continue;
    const g = locate(it.title) || locate(it.desc);
    if (c.foreign && (!g || g.area)) continue;
    if (!g && !f.keepUnlocated) continue;
    seenLinks.add(it.link); seenTitles.add(key(it.title)); kept++;
    const art = { t: it.title, url: it.link, src: it.src, date: it.date };
    const w = words(it.title);
    const match = events.find(e => Math.abs(e.date - it.date) < 48 * 3600e3 && (() => {
      const s = Math.max(...e.articles.map(a => jacc(w, words(a.t))));
      const samePlace = g && e.place && key(g.nom) === key(e.place);
      return s >= 0.45 || (samePlace && s >= 0.2) || (samePlace && e.type === c.type && s >= 0.12 && Math.abs(e.date - it.date) < 12 * 3600e3);
    })());
    if (match) {
      match.articles.push(art); match.articles.sort((a, b) => a.date - b.date); match.articles = match.articles.slice(0, 20);
      match.updated = Math.max(match.updated || match.date, it.date);
      if (SEVW[c.sev] > SEVW[match.sev]) { match.sev = c.sev; match.title = it.title; escalated.add(match.id); }
      if (!match.place && g) Object.assign(match, { place: g.nom, dep: g.dep || null, lat: g.lat, lon: g.lon, area: !!g.area });
    } else {
      const ev = { id: hash(it.link + it.title), title: it.title, sev: c.sev, type: c.type, date: it.date, updated: it.date,
        place: g ? g.nom : null, dep: g ? g.dep || null : null, lat: g ? g.lat : null, lon: g ? g.lon : null, area: g ? !!g.area : false,
        articles: [art], alerted: false };
      events.push(ev); newIds.add(ev.id);
    }
  }
  feedStatus.push({ name: f.name, ok: true, n: r.value.length, kept });
});

events.sort((a, b) => b.date - a.date);
events = events.slice(0, cfg.maxEvents || 1500);

/* ---------- Alertes push (ntfy.sh) ---------- */
const A = cfg.alerts || {};
const topic = process.env.NTFY_TOPIC;
const sevOK = s => SEVW[s] >= SEVW[A.minSeverity || "crit"];
const depOK = d => !A.departements?.length || A.departements.includes(d);
let sent = 0;
for (const e of events) {
  if (e.alerted || !sevOK(e.sev) || !depOK(e.dep)) continue;
  if (firstRun || !topic || NOW - e.date > 6 * 3600e3) { e.alerted = true; continue; }
  if (sent >= (A.maxPerRun || 8)) break;
  try {
    const where = e.place ? `${e.place}${e.dep && !e.area ? " (" + e.dep + ")" : ""}` : "Lieu non détecté";
    await fetch(`${process.env.NTFY_SERVER || A.server || "https://ntfy.sh"}/${encodeURIComponent(topic)}`, {
      method: "POST", body: `${where} · ${e.type}\n${e.articles[0].src}`,
      headers: { "Title": "=?UTF-8?B?" + Buffer.from(e.title.slice(0, 180)).toString("base64") + "?=", "Priority": e.sev === "crit" ? "5" : "4",
        "Tags": e.sev === "crit" ? "rotating_light" : "warning", "Click": e.articles[0].url, ...(A.pageUrl ? { "Actions": `view, Ouvrir la carte, ${A.pageUrl}` } : {}) },
      signal: AbortSignal.timeout(10000)
    });
    e.alerted = true; sent++;
  } catch (err) { log("ntfy :", err.message); }
}

await fs.mkdir(P("data/"), { recursive: true });
const out = { updated: new Date(NOW).toISOString(), feeds: feedStatus, events };
await fs.writeFile(P("data/data.json"), JSON.stringify(out));
log(`OK · ${feedStatus.filter(f => f.ok).length}/${FEEDS.length} flux · ${newIds.size} nouveaux faits · ${escalated.size} aggravés · ${events.length} au total · ${sent} alertes`);
feedStatus.filter(f => !f.ok).forEach(f => log("  ✗", f.name, f.error));
