// Veille France – récupère les flux RSS, localise, classe, regroupe et envoie les alertes.
// Lancé toutes les 10 minutes par GitHub Actions (voir .github/workflows/update.yml).
import fs from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { enrichManifs, initGeo, saveGeo, geocode, findOrgs } from "./manif.mjs";
import { fetchPlanned, mergePlanned, futureDate, ANNOUNCE, looksLikeDemo } from "./planned.mjs";
import { fetchBluesky } from "./bluesky.mjs";
import { analyzeVersions } from "./versions.mjs";

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
for (const [nom, dep, lat, lon, pop] of communes) {
  const m = nom.match(/^([^-]{3,})-(sur|sous|lès|les|le|la|en|aux|de|du|d'[^-]+)-/i) || (pop >= 50000 && nom.match(/^([^-]{4,})-/));
  if (!m) continue;
  if (pop < 20000) continue;
  const k = key(m[1]); if (!k || ["saint", "sainte", "notre"].includes(k)) continue;
  if (!CITY.has(k)) CITY.set(k, []);
  CITY.get(k).push({ nom, dep, lat, lon, pop, alias: true });
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
      // « Laurence de Charette », « Jean d'Ormesson » : un nom de famille, pas une ville
      const before = s >= 2 ? toks[s - 2].raw : "", surname = (prev === "de" || prev === "d") && /^\p{Lu}[\p{Ll}-]+$/u.test(before) && !/^(Saint|Sainte|Ville|Pays|Communaute|Region|Departement|Prefecture|Mairie|Place|Rue|Gare|Port|Pont|Porte|Ile|Val|Mont|Bois|Fort|Centre|Quartier|Lycee|College|Universite|Tribunal|Hopital|CHU|Maison|Eglise|Cathedrale|Commune|Metropole|Agglomeration|Bassin|Golfe|Baie|Cote|Plaine|Vallee|Marais)$/u.test(norm(before));
      if (surname && !(CITY.has(k) && pickHomonym(CITY.get(k)).pop >= 20000)) continue;
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
const R_GRAVE = /\b(blesse\w*|poignard\w*|coups? de couteau|couteau|fusillade\w*|tirs?|par balles?|balles?|griev\w*|viol|violee|violees|enlev\w*|sequestr\w*|incendie criminel|arme a feu|kalachnikov|pronostic vital|machette|arme blanche|lynch\w*|passage a tabac|tabasse\w*|urgence absolue|jets? de (pierres?|projectiles?|cocktails?)|perd(u)? (un|son) oeil|eborgne\w*)\b/;
const R_ELEVE = /\b(agress\w*|violences?|violent\w*|emeute\w*|rixe\w*|braquage\w*|braque\w*|affrontement\w*|interpell\w*|garde a vue|casseur\w*|mortier\w*|degradation\w*|vol a main armee|menace\w*|incendi\w*|refus d.obtemperer|narcotrafic\w*|trafic de drogue|reglement de comptes?|frappe\w*|cambriol\w*|home-jacking|car-jacking|guet-apens|caillasse\w*)\b/;
const NOISE = /\b(football|ligue 1|match|rugby|tennis|film|serie|cinema|bande-annonce|critique|livre|roman|horoscope|meteo|recette|bourse|cac 40|jeu video|playstation|netflix|podcast|exposition|concert|festival|anniversaire de la mort|il y a \d+ ans|proces de|condamne a|jugement|cour d'assises|en appel|requisitions?|saison \d|editorial|edito|tribune|chronique|billet d.humeur|point de vue|cortege nuptial|mariage|nuptial|vehicules (americains|anciens|de collection)|voitures (anciennes|de collection)|retro|concentration de motos|salon de|brocante|messi|equipe de france|selection nationale|mondial|coupe du monde|ligue des champions|escape game|murder party|enquete immersive|jeu de piste|nosocomiales?|infections?|epidemie|maladie|grippe|covid|canicule|intoxication alimentaire|requis\w*|perpetuite|verdict|condamne\w*|assises|tribunal|mis en examen|juge\w* pour)\b/;
const FOREIGN = /\b(argentin\w*|chili\w*|perou|canada|quebec|australie|japon|coree|etats-unis|americain\w*|ukraine|ukrainien\w*|russie|russe\w*|gaza|israel\w*|liban\w*|iran\w*|syrie\w*|soudan|mexique|bresil|inde|chine|chinois|espagne|espagnol\w*|italie|italien\w*|allemagne|allemand\w*|belgique|belge\w*|suisse|royaume-uni|britannique\w*|londres|new york|texas|californie|afrique|algerie|maroc|tunisie|turquie|pakistan|afghanistan|venezuela|colombie|haiti|nigeria|congo|yemen|irak|cisjordanie)\b/;
const TYPES = [
  ["Terrorisme", /attentat|terroris/], ["Violences conjugales", /conjoint|compagne|compagnon|feminicide|ex-mari|ex-femme|epouse|violences conjugales/],
  ["Refus d'obtempérer, police", /refus d.obtemperer|policiers? (blesse|agresse|vise|percute)|gendarmes? (blesse|agresse|percute)/], ["Arme à feu", /fusillade|\btirs?\b|\bballes?\b|arme a feu|kalach|abattu/],
  ["Arme blanche", /couteau|poignard|machette|arme blanche/], ["Émeutes, manifs", /manif|emeute|casseur|blocus|mortier|affrontement|violences urbaines|lyceen/],
  ["Refus d'obtempérer, police", /refus d.obtemperer|policiers? (blesse|agresse|vise|percute)|gendarmes? (blesse|agresse|percute)/],
  ["Violences sexuelles", /\bviol\b|\bviolee|agression sexuelle/], ["Incendie", /incendi/],
  ["Trafic, règlement de comptes", /trafic|narco|reglement de compte|point de deal/], ["Agression", /agress|rixe|frapp|tabac|lynch|tabasse/],
  ["Braquage, vol", /braqu|vol a main|cambriol|jacking/]
];
const SEVW = { crit: 3, grave: 2, eleve: 1, info: 0 };
// Manifestations et interventions en cours
const R_MANIF = /\b(manifestation\w*|manifestant\w*|manifester|manifesteront|manifestent|appel a la greve|journee de mobilisation|rassemblement\w*|cortege\w*|defile\w*|blocus|blocage\w*|mobilisation\w*|sit-in|marche blanche|piquet de greve|emeute\w*|affrontement\w*|violences urbaines|nuit de violences|occupation d\w*)\b/;
// Manifestation : il faut un vrai mot de manif dans le titre (pas juste « mobilisation » ou « affrontements »)
const R_DEMO = /\b(manifs?|manifestation\w*|manifestant\w*|manifester|manifesteront|manifestent|rassemblement\w*|cortege\w*|defile\w*|blocus|blocage\w* (de|des|du|d.)\s?(lycee|universite|fac|route|rocade|peripherique|raffinerie|depot|port|autoroute|axe|ville|pont)\w*|sit-in|marche blanche|marche (pour|contre|de soutien)|piquet de greve|occupation d(u|e la|es) \w+)\b/;
// Intervention en cours : opération des forces de l'ordre (ou des secours) qui se déroule MAINTENANT
const R_INTERV = /\b(raid|gign|bri|forcene\w*|retranche\w*|prise d.otages?|otages?|braquage|braqueurs?|chasse a l.homme|traque|perimetre de securite|boucle\w*|evacu\w*|colis suspect|alerte a la bombe|alerte (a l.)?attentat|intervention|operation de (police|gendarmerie)|policiers? (deploye|mobilise|sur place|deployes|mobilises)|forces de l.ordre|crs|helicoptere|individu arme|homme arme|tireur|fusillade|charges?|gaz lacrymogenes?|interpellations? en cours)\b/;
const R_NOW = /\b(en cours|actuellement|en ce moment|a l.instant|toujours (retranche|en cours|sur place|boucle|recherche|en fuite)|depuis (ce matin|cet apres-midi|ce soir|plusieurs heures|\d+ ?h(eures?)?)|en direct|direct|live|se poursui\w*|intervient|interviennent|est retranche|sont retranches|est boucle|sont deployes|sont mobilises|est en cours|encercl\w*|en fuite|recherche(s|nt)? activement|evacue(s|es)? par precaution|alerte en cours|retranche (chez|dans)|(quartier|rue|secteur|zone|gare|centre-ville|immeuble|lycee|college|ecole|magasin) (est )?(boucle|evacue|confine)\w*|confinement)\b/;
const R_ENDED = /\b(a ete (interpelle|maitrise|arrete|neutralise|libere|interpellee|arretee)|ont ete (interpelles|liberes|arretes|maitrises)|s.est rendu|s.est livre|leve\w*|a pris fin|termine\w*|apres (l.intervention|la prise|le braquage|avoir)|hier|la veille|la nuit derniere|(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) (soir|matin|apres-midi|dernier)|bilan|retour sur|condamne\w*|mis en examen|sera juge|garde a vue prolongee|enquete ouverte)\b/;
const R_ONGOING = /\b(en cours|actuellement|en ce moment|toujours en cours|se poursui\w*|en direct|direct)\b/;
const R_PAST = /\b(proces|condamne\w*|juge\w*|il y a \d+|la semaine derniere|bilan de|retour sur|anniversaire|commemor\w*)\b/;
// accidents, incendies sans indice criminel, animaux, procès : pas de la violence en cours
const CRIMINEL = /meurtre|homicide|agress|\btirs?\b|poignard|couteau|fusillade|delit de fuite|refus d.obtemperer|rodeo|volontaire|criminel|intentionnel|incendiaire|molotov|vandal|degrad|emeute|rixe|policier|gendarm/;
function isExcluded(t) {
  if (NOISE.test(t)) return true;
  if (/\b(accident\w*|collision|sortie de route|carambolage|motocross|noyade|noye\w*|electrocut\w*|crash|ulm|avalanche|intoxication|monoxyde|chute mortelle|percute par un train|happe par)\b/.test(t) && !CRIMINEL.test(t)) return true;
  if (/incendi|flammes|\bfeu\b/.test(t) && !CRIMINEL.test(t)) return true;
  if (/\b(chien|chat|cheval|animal|animaux|vache|mouton|betail)s?\b/.test(t) && !/\b(homme|femme|enfant|adolescent|personne|habitant|victime|policier|gendarme)\w*\b/.test(t)) return true;
  return false;
}
function classify(title, desc) {
  const strip = x => x.replace(/\b(contre|pour denoncer|denoncer|lutte contre|journee contre|marche contre) (les |la |le |l.)?(violences?|agressions?|feminicides?|racisme|harcelement|viols?|meurtres?)[\w' -]{0,40}/g, " ");
  title = strip(low(title)); desc = strip(low(desc));
  const t = low(title), all = t + " " + low(desc);
  if (NOISE.test(t)) return null;
  if (isExcluded(t)) return null;
  const now = R_NOW.test(t) && !R_ENDED.test(t);
  const kind = R_PAST.test(t) ? null : (R_INTERV.test(t) && now) ? "intervention" : (R_DEMO.test(t) && !R_ENDED.test(t)) ? "manif" : null;
  const ongoing = kind === "intervention" ? true : !!kind && R_ONGOING.test(all) && !R_ENDED.test(t);
  const ended = R_ENDED.test(t);
  let sev = null;
  if (R_CRIT.test(t)) sev = "crit"; else if (R_GRAVE.test(t)) sev = "grave"; else if (R_ELEVE.test(t)) sev = "eleve";
  else if (R_CRIT.test(all) || R_GRAVE.test(all)) sev = "eleve";
  if (!sev && !kind) return null;
  if (!sev && kind === "intervention" && !R_NOW.test(t)) return null;
  if (!sev) return kind ? { sev: "info", type: kind === "manif" ? "Manifestation" : "Intervention en cours", foreign: FOREIGN.test(t), kind, ongoing, ended } : null;
  return { sev, type: (TYPES.find(([, r]) => r.test(all)) || ["Autre"])[0], foreign: FOREIGN.test(t), kind, ongoing, ended };
}

/* ---------- Regroupement des articles qui parlent du même fait ---------- */
const STOPW = new Set("le la les un une des de du d l a au aux et ou en dans sur pour par avec sans ce cette ces son sa ses leur leurs qui que quoi dont est sont a ont ete etre apres avant lors pres plus deux trois quatre cinq ans an homme femme jeune selon ce qu il elle ils elles on nous vous se ne pas y".split(" "));
const words = t => new Set(key(t).split(" ").filter(w => w.length > 2 && !STOPW.has(w)));
const jacc = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i || 1); };

/* ---------- Dates ---------- */
const FR_M = { janv: "Jan", janvier: "Jan", fevr: "Feb", fev: "Feb", fevrier: "Feb", mars: "Mar", avr: "Apr", avril: "Apr", mai: "May", juin: "Jun", juil: "Jul", juillet: "Jul", aout: "Aug", sept: "Sep", septembre: "Sep", oct: "Oct", octobre: "Oct", nov: "Nov", novembre: "Nov", dec: "Dec", decembre: "Dec" };
function parseDate(s) {
  if (!s) return NaN;
  const fr = String(s).match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2})[:h](\d{2}))?/);
  if (fr) return Date.parse(`${fr[3]}-${fr[2].padStart(2, "0")}-${fr[1].padStart(2, "0")}T${(fr[4] || "12").padStart(2, "0")}:${fr[5] || "00"}:00+02:00`);
  let d = Date.parse(s); if (!isNaN(d)) return d;
  let t = low(s).replace(/\b(janvier|janv|fevrier|fevr|fev|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\.?/g, m => FR_M[m.replace(".", "")]);
  t = t.replace(/\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lun|mar|mer|jeu|ven|sam|dim)\.?,?/g, "").replace(/\bh\b/g, ":").trim();
  d = Date.parse(t); if (!isNaN(d)) return d;
  const m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (m) return Date.parse(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${(m[4] || "12").padStart(2, "0")}:${m[5] || "00"}:00+02:00`);
  return NaN;
}

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
    const d = parseDate(txt(it.pubDate) || txt(it.published) || txt(it.updated) || txt(it["dc:date"]) || txt(it["dc:Date"]) || txt(it.date));
    return { title, link: link.trim(), src, date: isNaN(d) ? NOW : Math.min(d, NOW), nodate: isNaN(d), desc: stripHtml(txt(it.description) || txt(it.summary) || txt(it["content:encoded"])).slice(0, 500) };
  }).filter(i => i.title && i.link);
}

/* ---------- Programme principal ---------- */
const prev = await readJSON(P("data/data.json"), { events: [] });
const firstRun = !prev.updated || !prev.events.some(e => !e.seed);
let events = (prev.events || []).filter(e => NOW - e.date <= KEEP_MS).filter(e => e.seed || e.kind || !isExcluded(low(e.title)))
  .filter(e => { if (e.kind === "manif" && !e.seed && (!R_DEMO.test(low(e.title)) || R_ENDED.test(low(e.title)))) { delete e.kind; delete e.ongoing; return e.sev !== "info"; } return true; })
  .filter(e => e.seed || !NOISE.test(low(e.title)));
const seenLinks = new Set(events.flatMap(e => e.articles.map(a => a.url)));
const seenTitles = new Set(events.flatMap(e => e.articles.map(a => key(a.t))));
const feedStatus = [];
await initGeo(P("data/geocache.json"), +(process.env.GEO_BUDGET || 45));
let planned = (prev.planned || []).filter(p => p.start > NOW - 8 * 3600e3);
let plannedNew = 0;
const newIds = new Set(), escalated = new Set();

const SOURCES = FEEDS.map(f => ({ f, p: fetchText(f.url).then(x => parseFeed(x, f)) }));
if (cfg.bluesky?.enabled !== false && (!process.env.FEEDS_OVERRIDE || process.env.BSKY_FILE))
  SOURCES.push({ f: { name: "Bluesky", url: "bluesky" }, p: fetchBluesky(cfg.bluesky || {}, process.env, log) });
const results = await Promise.allSettled(SOURCES.map(x => x.p));
let witnesses = 0;
results.forEach((r, i) => {
  const f = SOURCES[i].f;
  if (r.status !== "fulfilled") { feedStatus.push({ name: f.name, ok: false, error: String(r.reason?.message || r.reason).slice(0, 80) }); return; }
  let kept = 0;
  for (const it of r.value) {
    if (NOW - it.date > KEEP_MS) continue;
    if (seenLinks.has(it.link) || seenTitles.has(key(it.title))) continue;
    const c = classify(it.title, it.desc); if (!c) continue;
    // une intervention n'est « en cours » que si l'article vient de tomber
    if (c.kind === "intervention" && NOW - it.date > 90 * 60e3) { c.kind = null; c.ongoing = false; if (c.sev === "info") continue; }
    let g = locate(it.title);
    if (!g || g.area) { const g2 = locate(it.desc); if (g2 && (!g || (!g2.area && g2.dep === g.dep))) g = g2; }
    if (c.foreign && (!g || g.area)) continue;
    // annonce d'une manif à venir : va dans « prévues », pas sur la carte des faits
    if (c.kind === "manif" && (!it.bsky || it.trusted) && ANNOUNCE.test(low(it.title + " " + it.desc))) {
      const fd = futureDate(it.title + " " + it.desc, it.date);
      if (fd && fd.ts > it.date + 2 * 3600e3 && fd.ts < NOW + 30 * 864e5) {
        const txt = it.title + " " + it.desc;
        if (mergePlanned(planned, { id: "p" + hash(it.link), title: it.title, start: fd.ts, end: null, hasTime: fd.hasTime,
          place: g && !g.area ? g.nom : (g ? g.nom : null), dep: g ? g.dep || null : null, lat: g ? g.lat : null, lon: g ? g.lon : null, precise: false,
          where: null, orgs: findOrgs(txt), sources: [{ src: it.src, url: it.link }], origin: "presse" })) plannedNew++;
        seenLinks.add(it.link); seenTitles.add(key(it.title)); kept++;
        continue;
      }
    }
    if (!g && !f.keepUnlocated) continue;
    if (it.bsky && !it.trusted) {
      // simple témoignage : rattaché à un fait déjà connu au même endroit, jamais de création
      const w0 = words(it.title);
      const ev = events.find(e => e.place && key(e.place) === key(g.nom) && Math.abs(e.date - it.date) < 6 * 3600e3 &&
        (c.kind ? e.kind === c.kind : SEVW[e.sev] >= 1 && Math.max(...e.articles.map(a => jacc(w0, words(a.t)))) >= 0.12));
      if (ev) { ev.witness = ev.witness || []; if (!ev.witness.some(x => x.url === it.link) && ev.witness.length < 15) { ev.witness.push({ url: it.link, date: it.date }); witnesses++; kept++; } }
      seenLinks.add(it.link);
      continue;
    }
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
      if (c.kind && !match.kind) match.kind = c.kind;
      if (c.ongoing) match.ongoing = true;
      if (c.ended && match.kind === "intervention" && it.date >= (match.updated || match.date) - 600e3) match.ended = true;
      if (!match.place && g) Object.assign(match, { place: g.nom, dep: g.dep || null, lat: g.lat, lon: g.lon, area: !!g.area });
    } else {
      const ev = { id: hash(it.link + it.title), title: it.title, sev: c.sev, type: c.type, date: it.date, updated: it.date,
        place: g ? g.nom : null, dep: g ? g.dep || null : null, lat: g ? g.lat : null, lon: g ? g.lon : null, area: g ? !!g.area : false,
        articles: [art], alerted: false, ...(c.kind ? { kind: c.kind, ongoing: c.ongoing } : {}), ...(c.kind === "manif" && it.desc ? { desc: it.desc.slice(0, 400) } : {}) };
      events.push(ev); newIds.add(ev.id);
    }
  }
  feedStatus.push({ name: f.name, ok: true, n: r.value.length, kept });
});

events.sort((a, b) => b.date - a.date);
events = events.slice(0, cfg.maxEvents || 1500);

/* ---------- Manifestations : organisateurs, parcours, motifs ---------- */
try {
  const n = await enrichManifs(events, { now: NOW, cacheFile: P("data/geocache.json"), maxEvents: cfg.manifPerRun || 8, log });
  if (n) log(`${n} manif(s) analysée(s)`);
} catch (err) { log("analyse des manifs :", err.message); }
try { await analyzeVersions(events, { now: NOW, maxFetch: cfg.versionsFetchPerRun || 24, log }); }
catch (err) { log("versions :", err.message); }

/* ---------- Agendas militants (une fois par heure) ---------- */
let plannedFetched = prev.plannedFetched || 0, agendaStatus = prev.agendaStatus || null;
if (cfg.agendas?.enabled !== false && !process.env.FEEDS_OVERRIDE && NOW - plannedFetched > 55 * 60e3) {
  try {
    const r = await fetchPlanned({ now: NOW, communes, geocode, locate: t => locate(t), log, instances: cfg.agendas?.demosphere });
    for (const it of r.items) if (mergePlanned(planned, it)) plannedNew++;
    plannedFetched = NOW; agendaStatus = { ok: r.ok, total: r.total };
  } catch (err) { log("agendas :", err.message); }
}
planned.sort((a, b) => a.start - b.start); planned = planned.slice(0, 500);
await saveGeo();
log(`${planned.length} manifs prévues (${plannedNew} nouvelles)`);

/* ---------- Alertes push (ntfy.sh) ---------- */
const A = cfg.alerts || {};
const topic = process.env.NTFY_TOPIC;
const sevOK = s => SEVW[s] >= SEVW[A.minSeverity || "crit"];
const depOK = d => !A.departements?.length || A.departements.includes(d);
// zone autour d'un point : "zone": { "lat": 48.85, "lon": 2.35, "km": 20 }
const zoneOK = e => { const z = A.zone; if (!z || z.lat == null) return true; if (e.lat == null) return false;
  const r = Math.PI / 180, x = Math.sin((e.lat - z.lat) * r / 2) ** 2 + Math.cos(z.lat * r) * Math.cos(e.lat * r) * Math.sin((e.lon - z.lon) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x)) <= (z.km || 20); };
let sent = 0;
for (const e of events) {
  if (e.alerted || !(sevOK(e.sev) || (A.live && e.kind)) || !depOK(e.dep) || !zoneOK(e)) continue;
  if (firstRun || !topic || NOW - e.date > 6 * 3600e3) { e.alerted = true; continue; }
  if (sent >= (A.maxPerRun || 8)) break;
  try {
    const where = e.place ? `${e.place}${e.dep && !e.area ? " (" + e.dep + ")" : ""}` : "Lieu non détecté";
    await fetch(`${process.env.NTFY_SERVER || A.server || "https://ntfy.sh"}/${encodeURIComponent(topic)}`, {
      method: "POST", body: `${where} · ${e.type}\n${e.articles[0].src}`,
      headers: { "Title": "=?UTF-8?B?" + Buffer.from(((e.kind && SEVW[e.sev] < 2) ? "EN COURS · " : "") + e.title.slice(0, 170)).toString("base64") + "?=", "Priority": e.sev === "crit" ? "5" : "4",
        "Tags": e.sev === "crit" ? "rotating_light" : "warning", "Click": e.articles[0].url, ...(A.pageUrl ? { "Actions": `view, Ouvrir la carte, ${A.pageUrl}` } : {}) },
      signal: AbortSignal.timeout(10000)
    });
    e.alerted = true; sent++;
  } catch (err) { log("ntfy :", err.message); }
}

await fs.mkdir(P("data/"), { recursive: true });
if (agendaStatus) feedStatus.push({ name: "Agendas Démosphère", ok: agendaStatus.ok > 0, n: agendaStatus.ok, kept: planned.filter(p => p.origin === "agenda").length });
const out = { updated: new Date(NOW).toISOString(), feeds: feedStatus, events, planned, plannedFetched, agendaStatus };
await fs.writeFile(P("data/data.json"), JSON.stringify(out));
log(`OK · ${feedStatus.filter(f => f.ok).length}/${SOURCES.length} sources · ${witnesses} témoignages Bluesky · ${newIds.size} nouveaux faits · ${escalated.size} aggravés · ${events.length} au total · ${sent} alertes`);
feedStatus.filter(f => !f.ok).forEach(f => log("  ✗", f.name, f.error));
