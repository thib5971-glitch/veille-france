// Enrichit les manifestations : organisateurs, parcours (départ → arrivée), motifs, foule, heure de rendez-vous.
// Sources : titres et résumés RSS + texte des articles quand le lien est direct.
// Géocodage : Nominatim (OpenStreetMap), tracé à pied : routing.openstreetmap.de. Tout est mis en cache.
import fs from "node:fs/promises";

const UA = "VeilleFrance/1.0 (carte d'actualité ; github actions)";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’ʼ]/g, "'");

/* ---------- Organisateurs connus ----------
   type : syndicat, parti, collectif. "famille" n'est renseignée que pour les partis,
   selon le classement le plus courant dans la presse française. */
export const ORGS = [
  // syndicats de salariés
  ["CGT", "Confédération générale du travail", "syndicat", null, /\bCGT\b/],
  ["FO", "Force ouvrière", "syndicat", null, /\bFO\b|Force ouvri[eè]re/],
  ["CFDT", "Confédération française démocratique du travail", "syndicat", null, /\bCFDT\b/],
  ["Solidaires", "Union syndicale Solidaires (SUD)", "syndicat", null, /\bSolidaires\b|\bSUD[- ](?:Rail|Santé|Éducation|PTT|Industrie)|\bSUD\b/],
  ["FSU", "Fédération syndicale unitaire", "syndicat", null, /\bFSU\b|\bSNES(?:-FSU)?\b/],
  ["UNSA", "Union nationale des syndicats autonomes", "syndicat", null, /\bUNSA\b/],
  ["CFE-CGC", "CFE-CGC", "syndicat", null, /\bCFE[- ]CGC\b/],
  ["CFTC", "Confédération française des travailleurs chrétiens", "syndicat", null, /\bCFTC\b/],
  // étudiants, lycéens
  ["UNEF", "Union nationale des étudiants de France", "syndicat", null, /\bUNEF\b/],
  ["Union étudiante", "Union étudiante", "syndicat", null, /Union [ée]tudiante/],
  ["FAGE", "Fédération des associations générales étudiantes", "syndicat", null, /\bFAGE\b/],
  ["USL", "Union syndicale lycéenne", "syndicat", null, /\bUSL\b|Union syndicale lyc[ée]enne/],
  ["La Voix lycéenne", "La Voix lycéenne", "syndicat", null, /Voix lyc[ée]enne/],
  // agriculteurs
  ["FNSEA", "FNSEA", "syndicat", null, /\bFNSEA\b/],
  ["Jeunes Agriculteurs", "Jeunes Agriculteurs", "syndicat", null, /Jeunes [Aa]griculteurs/],
  ["Coordination rurale", "Coordination rurale", "syndicat", null, /Coordination rurale/],
  ["Confédération paysanne", "Confédération paysanne", "syndicat", null, /Conf[ée]d[ée]ration paysanne/],
  // police
  ["Alliance", "Alliance Police nationale", "syndicat", null, /Alliance[- ]Police|syndicat Alliance/],
  ["Unité SGP", "Unité SGP Police", "syndicat", null, /Unit[ée] SGP/],
  // partis
  ["LFI", "La France insoumise", "parti", "Gauche radicale", /\bLFI\b|France insoumise|\binsoumis(?:es)?\b/i],
  ["PS", "Parti socialiste", "parti", "Gauche", /\bPS\b|Parti socialiste/],
  ["PCF", "Parti communiste français", "parti", "Gauche", /\bPCF\b|Parti communiste/],
  ["Les Écologistes", "Les Écologistes (ex-EELV)", "parti", "Gauche écologiste", /\bEELV\b|Les [ÉE]cologistes/],
  ["Place publique", "Place publique", "parti", "Gauche", /Place publique/],
  ["NPA", "Nouveau Parti anticapitaliste", "parti", "Extrême gauche", /\bNPA\b/],
  ["LO", "Lutte ouvrière", "parti", "Extrême gauche", /Lutte ouvri[eè]re/],
  ["Renaissance", "Renaissance", "parti", "Centre", /\bRenaissance\b(?! du)/],
  ["MoDem", "Mouvement démocrate", "parti", "Centre", /\bMoDem\b/],
  ["Horizons", "Horizons", "parti", "Centre droit", /\bHorizons\b/],
  ["LR", "Les Républicains", "parti", "Droite", /\bLR\b|Les R[ée]publicains/],
  ["RN", "Rassemblement national", "parti", "Extrême droite", /\bRN\b|Rassemblement national/],
  ["Reconquête", "Reconquête", "parti", "Extrême droite", /Reconqu[êe]te/],
  ["Les Patriotes", "Les Patriotes", "parti", "Souverainiste", /Les Patriotes/],
  ["DLF", "Debout la France", "parti", "Droite souverainiste", /Debout la France/],
  ["UPR", "Union populaire républicaine", "parti", "Souverainiste", /\bUPR\b/],
  ["Action française", "Action française", "parti", "Extrême droite", /Action fran[çc]aise/],
  // collectifs et associations
  ["Gilets jaunes", "Gilets jaunes", "collectif", null, /[Gg]ilets? jaunes?/],
  ["Extinction Rebellion", "Extinction Rebellion", "collectif", null, /Extinction Rebellion|\bXR\b/],
  ["Soulèvements de la Terre", "Les Soulèvements de la Terre", "collectif", null, /Soul[èe]vements de la [Tt]erre/],
  ["Dernière Rénovation", "Dernière Rénovation", "collectif", null, /Derni[èe]re R[ée]novation/],
  ["Attac", "Attac", "collectif", null, /\bAttac\b/],
  ["NousToutes", "NousToutes", "collectif", null, /Nous ?Toutes/],
  ["LDH", "Ligue des droits de l'Homme", "collectif", null, /\bLDH\b|Ligue des droits de l/],
  ["SOS Racisme", "SOS Racisme", "collectif", null, /SOS Racisme/],
  ["Urgence Palestine", "Urgence Palestine", "collectif", null, /Urgence Palestine/],
  ["Inter-LGBT", "Inter-LGBT", "collectif", null, /Inter-?LGBT/],
  ["Manif pour tous", "La Manif pour tous / Syndicat de la famille", "collectif", null, /Manif pour tous|Syndicat de la famille/],
  ["Némésis", "Collectif Némésis", "collectif", null, /N[ée]m[ée]sis/],
  ["Greenpeace", "Greenpeace", "collectif", null, /Greenpeace/],
  ["Act Up", "Act Up", "collectif", null, /Act[- ]Up/],
  ["Intersyndicale", "Intersyndicale", "syndicat", null, /[Ii]ntersyndicale/]
].map(([sigle, nom, type, famille, re]) => ({ sigle, nom, type, famille, re }));

/* ---------- Extraction dans le texte ---------- */
const LIEU = "(?:place|rue|avenue|av\\.|boulevard|bd|cours|quai|esplanade|parvis|pont|gare|porte|square|jardin|parc|rond-point|allées?|promenade|carrefour|préfecture|sous-préfecture|hôtel de ville|mairie|assemblée nationale|sénat|ministère|palais|rectorat|université|campus|lycée|hôpital|CHU|tribunal|conseil (?:départemental|régional))";
const STOPWORDS = /\s+(?:à|a|ce|cet|cette|ces|dès|vers|pour|contre|en soutien|avant|après|puis|le|ou|où|et|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi|demain|aujourd'hui|en fin|en début|à partir|avec|sous|depuis|jusqu|au moment|alors|tandis|afin|ont|sont|a été|était|qui|dans|lors|malgré|sans|entre)(?=[\s,.;:']|$).*$/i;
const clean = s => s.replace(STOPWORDS, "").replace(/[«»"“”]/g, "").replace(/\s+/g, " ").trim().replace(/[\s,;:.)-]+$/, "");
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const PLACE = `(${LIEU}(?:\\s+(?:de la|du|des|de l'|d'|de|la|le|l'))?\\s*[A-ZÉÈÀÂÎÔÛÇ0-9][\\wÀ-ÿ'’\\- ]{1,45}|${LIEU})`;
const RX = {
  fromTo: new RegExp(`(?:de|depuis|entre)\\s+(?:la |le |l'|les )?${PLACE}\\s+(?:à|a|jusqu'à|jusqu'au|vers|et)\\s+(?:la |le |l'|les )?${PLACE}`, "i"),
  from: new RegExp(`(?:départ|partir|partira|partiront|partie|parti|partant|s'élancer\\w*|élancé\\w*|rassemblés?|rassemblement|rendez-vous|rdv|réunis|réunies|massés?)\\s+(?:est\\s+(?:prévu|donné)\\s+)?(?:à\\s+\\d{1,2}\\s?h(?:\\d{2})?\\s+)?(?:de la |du |de l'|des |de |depuis (?:la |le |l')?|devant (?:la |le |l')?|sur (?:la |le |l')?|à (?:la |l')?|au |place )?${PLACE}`, "i"),
  to: new RegExp(`(?:arrivée|arriver|arrivera|arriveront|jusqu'(?:à|au)|en direction (?:de|du|des)|direction|vers|rejoindre|rejoindront|rallier|gagner|se diriger vers|terminer|se terminera|se disperser)\\s+(?:la |le |l'|les |à |au |devant (?:la |le |l')?)?${PLACE}`, "i"),
  at: new RegExp(`(?:devant|sur)\\s+(?:la |le |l')?${PLACE}`, "i"),
  any: /((?:[Pp]lace|[Pp]arvis|[Ee]splanade|[Rr]ue|[Aa]venue|[Bb]oulevard|[Qq]uai|[Cc]ours|[Pp]ont|[Pp]orte|[Gg]are)\s+(?:de la |du |des |de l'|d'|de )?[A-ZÉÈÀÂÎÔÛÇ][\wÀ-ÿ'’\-]+(?:\s+(?:de la |du |des |de l'|d'|de )?[A-ZÉÈÀÂÎÔÛÇ0-9][\wÀ-ÿ'’\-]+){0,3})/,
  fromTo2: /(?:cortège|manifestation|marche|défilé|parcours|ira|iront|partira|partiront|reliera|ralliera|manifesteront|défileront)[^.]{0,30}?\b(?:du|de la|de l'|depuis (?:le |la |l')?)\s*([A-ZÉÈ][\wÀ-ÿ'’\-]+(?:\s[\wÀ-ÿ'’\-]+){0,3}?)\s+(?:à|jusqu'à|jusqu'au|vers|au)\s+((?:la |le |l')?[\wÀ-ÿ'’\-]+(?:\s[\wÀ-ÿ'’\-]+){0,4})/,
  rdv: /(?:à|dès|vers|rendez-vous à|rdv à|départ à|à partir de)\s+(\d{1,2})\s?h\s?(\d{2})?/i,
  foule: /(\d{1,3}(?:[\s.  ]\d{3})*|\d+)\s+(manifestants|personnes|participants|tracteurs)(?:[^.]{0,40}?(selon (?:la police|la préfecture|les organisateurs|le ministère de l'Intérieur|la CGT|les syndicats)))?/i,
  motif: /\b(contre|pour|réclam\w*|dénonc\w*|revendiqu\w*|exig\w*|s'opposer à|s'opposent à|en soutien (?:à|aux?)|soutenir|défendre|protester contre|en hommage à)\s+([^.;:!?()«»"]{4,90})/gi
};
const NOT_MOTIF = /^(la police|les forces de l'ordre|les gendarmes|des heures|plusieurs heures|la première fois|le moment|l'instant)/i;

export function extract(text) {
  const t = (text || "").replace(/\s+/g, " ");
  const out = { from: null, to: null, rdv: null, foule: null, motifs: [] };
  let m = t.match(RX.fromTo);
  if (m) { out.from = cap(clean(m[1])); out.to = cap(clean(m[2])); }
  if (!out.from && (m = t.match(RX.from))) out.from = cap(clean(m[1]));
  if (!out.to && (m = t.match(RX.to))) { const v = cap(clean(m[1])); if (!out.from || norm(v) !== norm(out.from)) out.to = v; }
  if (!out.from && (m = t.match(RX.at))) out.from = cap(clean(m[1]));
  if (!out.from && !out.to && (m = t.match(RX.fromTo2))) { out.from = cap(clean(m[1])); out.to = cap(clean(m[2])); }
  if (!out.from && (m = t.match(RX.any))) out.from = cap(clean(m[1]));
  if ((m = t.match(RX.rdv))) { const h = +m[1]; if (h >= 5 && h <= 23) out.rdv = `${h}h${m[2] || ""}`; }
  if ((m = t.match(RX.foule))) out.foule = `${m[1].replace(/[\s.  ]/g, " ").trim()} ${m[2]}${m[3] ? " " + m[3] : ""}`;
  const seen = new Set();
  for (const mm of t.matchAll(RX.motif)) {
    let verb = mm[1].toLowerCase(), obj = mm[2].trim().split(/\s+/).slice(0, 10).join(" ").replace(/[,\s]+$/, "");
    obj = obj.replace(/,?\s+(?:à l'appel|à l'initiative|selon|a indiqué|ont indiqué|explique|précise).*$/i, "").replace(/[,\s]+$/, "");
    if (verb === "pour" && /^(rejoindre|se rendre|aller|partir|arriver|rallier|gagner|la première|le moment|l'instant|des raisons)/i.test(obj)) continue;
    let phrase = `${verb} ${obj}`;
    const inner = phrase.match(/^pour\s+((?:d[ée]noncer|protester contre|r[ée]clamer|exiger|d[ée]fendre|soutenir|demander|s'opposer à)\s.+)$/i);
    if (inner) phrase = inner[1];
    if (NOT_MOTIF.test(obj) || obj.length < 5) continue;
    const k = norm(phrase).toLowerCase().slice(0, 40);
    if (seen.has(k)) continue; seen.add(k);
    out.motifs.push(phrase);
    if (out.motifs.length >= 3) break;
  }
  // un lieu trop vague ("place", "mairie" seul) ne sert à rien sans nom
  for (const k of ["from", "to"]) if (out[k] && (/^(place|rue|avenue|boulevard|bd|cours|quai|pont|gare|porte|parc|square|jardin|esplanade|parvis|lycée|université|campus|palais|ministère|\d+h\d*)$/i.test(out[k]) || out[k].length < 4)) out[k] = null;
  return out;
}

export function findOrgs(text) {
  const found = [];
  for (const o of ORGS) if (o.re.test(text)) found.push({ sigle: o.sigle, nom: o.nom, type: o.type, famille: o.famille });
  return found.slice(0, 8);
}

/* ---------- Texte des articles ---------- */
export async function articleText(url) {
  if (!/^https?:\/\//.test(url) || /news\.google\.|bsky\.app/.test(url)) return "";
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; VeilleFrance/1.0)", "Accept-Language": "fr-FR,fr" }, signal: AbortSignal.timeout(12000), redirect: "follow" });
    if (!r.ok) return "";
    const html = (await r.text()).slice(0, 600000);
    const meta = [...html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)/gi)].map(m => m[1]);
    const paras = [...html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "").matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1].replace(/<[^>]+>/g, " ")).filter(p => p.length > 40).slice(0, 40);
    return [...meta, ...paras].join(" ").replace(/&nbsp;/g, " ").replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à").replace(/\s+/g, " ").slice(0, 12000);
  } catch { return ""; }
}

/* ---------- Géocodage et tracé ---------- */
let geoCache = null, lastGeo = 0, geoFile = null, geoBudget = 45;
export async function initGeo(file, budget = 45) { geoFile = file; geoBudget = budget; if (geoCache) return; try { geoCache = JSON.parse(await fs.readFile(file, "utf8")); } catch { geoCache = {}; } }
export async function saveGeo() { if (geoFile && geoCache) await fs.writeFile(geoFile, JSON.stringify(geoCache)); }
const loadCache = file => initGeo(file);
export async function geocode(place, city, near) {
  const key = norm(`${place}|${city}`).toLowerCase();
  if (key in geoCache) return geoCache[key];
  if (geoBudget-- <= 0) return null;
  if (process.env.OFFLINE_GEO) { const v = near ? { lat: near.lat + (Math.random() - .5) * .02, lon: near.lon + (Math.random() - .5) * .02 } : null; geoCache[key] = v; return v; }
  const wait = 1100 - (Date.now() - lastGeo); if (wait > 0) await sleep(wait); lastGeo = Date.now();
  const p = new URLSearchParams({ q: `${place}, ${city}, France`, format: "jsonv2", limit: "1", countrycodes: "fr", "accept-language": "fr" });
  if (near) { const d = .25; p.set("viewbox", `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`); p.set("bounded", "1"); }
  let v = null;
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?" + p, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    if (r.ok) { const j = await r.json(); if (j[0]) v = { lat: +(+j[0].lat).toFixed(5), lon: +(+j[0].lon).toFixed(5) }; }
  } catch {}
  geoCache[key] = v; return v;
}
async function walkRoute(a, b) {
  if (process.env.OFFLINE_GEO) return [[a.lat, a.lon], [b.lat, b.lon]];
  for (const base of ["https://routing.openstreetmap.de/routed-foot/route/v1/driving/", "https://router.project-osrm.org/route/v1/foot/"]) {
    try {
      const r = await fetch(`${base}${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const j = await r.json(); const c = j?.routes?.[0]?.geometry?.coordinates;
      if (c?.length) { const step = Math.max(1, Math.ceil(c.length / 150)); return c.filter((_, i) => i % step === 0 || i === c.length - 1).map(([lo, la]) => [+la.toFixed(5), +lo.toFixed(5)]); }
    } catch {}
  }
  return [[a.lat, a.lon], [b.lat, b.lon]];
}

/* ---------- Programme ---------- */
export async function enrichManifs(events, { now, cacheFile, maxEvents = 8, log = () => {} }) {
  if (!geoCache) await loadCache(cacheFile);
  const todo = events
    .filter(e => e.kind === "manif" && now - (e.updated || e.date) < 8 * 3600e3)
    .filter(e => !e.manif || e.manif.n !== e.articles.length)
    .sort((a, b) => (b.updated || b.date) - (a.updated || a.date))
    .slice(0, maxEvents);
  for (const e of todo) {
    let text = e.articles.map(a => a.t).join(". ") + ". " + (e.desc || "");
    for (const a of e.articles.slice(0, 3)) text += " " + await articleText(a.url);
    const x = extract(text), orgs = findOrgs(text);
    const city = e.place && !e.area ? e.place : null, near = e.lat != null ? { lat: e.lat, lon: e.lon } : null;
    const m = { n: e.articles.length, orgs, motifs: x.motifs, rdv: x.rdv, foule: x.foule, from: null, to: null, route: null };
    if (city && x.from) { const g = await geocode(x.from, city, near); if (g) m.from = { label: x.from, ...g }; }
    if (city && x.to) { const g = await geocode(x.to, city, near); if (g) m.to = { label: x.to, ...g }; }
    if (!m.from && x.from) m.from = { label: x.from };
    if (!m.to && x.to) m.to = { label: x.to };
    if (m.from?.lat != null && m.to?.lat != null) m.route = await walkRoute(m.from, m.to);
    if (m.from?.lat != null) { e.lat = m.from.lat; e.lon = m.from.lon; e.precise = true; }
    e.manif = m;
    log(`  manif ${e.place || "?"} : ${orgs.map(o => o.sigle).join(", ") || "orga ?"} · ${m.from?.label || "?"} → ${m.to?.label || "?"}`);
  }
  return todo.length;
}
