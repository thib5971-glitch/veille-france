// Détecteur de versions : compare comment chaque source raconte le même fait.
// Pour chaque article : chiffres (morts, blessés, interpellations, foule selon qui) et mots employés.
// Pour chaque fait : chronologie, chiffres qui divergent entre sources proches dans le temps, récits opposés.
import { articleText } from "./manif.mjs";

const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’ʼ]/g, "'").toLowerCase();
const NUM = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, trente: 30, quarante: 40, cinquante: 50, cent: 100,
  "une dizaine": 10, "une douzaine": 12, "une quinzaine": 15, "une vingtaine": 20, "une trentaine": 30, "une quarantaine": 40, "une cinquantaine": 50, "une centaine": 100 };
const toN = s => { s = norm(s).trim(); if (/^\d/.test(s)) return +s.replace(/[\s.  ]/g, ""); return NUM[s] ?? null; };
const NUMRX = "(\\d{1,3}(?:[\\s.  ]\\d{3})+|\\d+|une (?:dizaine|douzaine|quinzaine|vingtaine|trentaine|quarantaine|cinquantaine|centaine)|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|cent)";

export const METRICS = { morts: "Morts", graves: "Blessés graves", blesses: "Blessés", forces: "Policiers ou gendarmes blessés", interp: "Interpellations" };
const R_BILAN = new RegExp(`\\b${NUMRX}\\s+(?:personnes?\\s+|jeunes?\\s+|hommes?\\s+|femmes?\\s+)?(morts?|tue(?:e|s|es)?|decede(?:e|s|es)?|blesses? graves?|grievement blesse(?:e|s|es)?|blesse(?:e|s|es)?|interpellations?|interpelle(?:e|s|es)?|gardes? a vue|(?:policiers?|gendarmes?|agents?|pompiers?) blesse(?:e|s|es)?)`, "g");
const R_FOULE = new RegExp(`\\b${NUMRX}\\s+(manifestants|personnes|participants)\\b[^.]{0,50}?\\bselon (la police|la prefecture|le ministere de l'interieur|les organisateurs|l'intersyndicale|la cgt|les syndicats|le cabinet occurrences|occurrences|le collectif)`, "g");
const WHO = w => /police|prefecture|ministere/.test(w) ? "police" : /occurrences/.test(w) ? "comptage indépendant" : "organisateurs";

// mots qui portent un récit ; "side" sert à repérer deux récits opposés du même fait
export const FRAMES = [
  ["affrontements", "Affrontements", /\baffrontements?\b/, "a"], ["heurts", "Heurts", /\bheurts?\b|echauffourees?/, "a"],
  ["charge", "Charge policière", /\bcharges? (policieres?|des forces de l'ordre|de police|des crs|des gendarmes)/, "b"],
  ["violpol", "Violences policières", /violences? policieres?/, "b"], ["lacry", "Gaz lacrymogène", /lacrymogenes?/, null],
  ["casseurs", "Casseurs", /\bcasseurs?\b/, "c"], ["blackbloc", "Black bloc", /black ?blocs?/, "c"], ["emeutiers", "Émeutiers", /\bemeutiers?\b/, "c"],
  ["pacifique", "Manifestation pacifique", /pacifiques?|dans le calme|bon enfant/, "d"],
  ["emeutes", "Émeutes", /\bemeutes?\b/, "e"], ["revolte", "Révolte, colère", /\brevoltes?\b|\bcolere\b/, "f"],
  ["feminicide", "Féminicide", /\bfeminicides?\b/, "g"], ["drame", "Drame familial / passionnel", /drame (familial|conjugal|passionnel)|crime passionnel/, "h"],
  ["refus", "Refus d'obtempérer", /refus d.obtemperer/, "i"], ["tirpol", "Tir policier", /(tir|tire|abattu)\w* (par )?(un |des )?(policiers?|gendarmes?)|policiers? (a|ont) (tire|fait feu)/, "j"],
  ["legitime", "Légitime défense", /legitime defense/, "i"], ["bavure", "Bavure", /\bbavures?\b/, "j"],
  ["reglement", "Règlement de comptes", /reglements? de comptes?|narchomicide|narco/, null], ["terro", "Terrorisme", /terroris/, null],
  ["ultradroite", "Ultradroite", /ultra-?droite|extreme droite/, null], ["ultragauche", "Ultragauche", /ultra-?gauche|extreme gauche|antifas?\b/, null]
];
const OPPOSED = [["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"], ["i", "j"]];

export function factsOf(text) {
  const t = norm(text), f = { b: {}, foule: [], mots: [] };
  for (const m of t.matchAll(R_BILAN)) {
    const n = toN(m[1]); if (n == null || n > 5000) continue;
    const w = m[2], k = /^(policier|gendarme|agent|pompier)/.test(w) ? "forces" : /mort|tue|decede/.test(w) ? "morts" : /grave|grievement/.test(w) ? "graves" : /interpell|garde/.test(w) ? "interp" : "blesses";
    f.b[k] = Math.max(f.b[k] || 0, n);
  }
  for (const m of t.matchAll(R_FOULE)) { const n = toN(m[1]); if (n && n >= 20) f.foule.push({ n, who: WHO(m[3]) }); }
  for (const [id, , rx] of FRAMES) if (rx.test(t)) f.mots.push(id);
  if (!Object.keys(f.b).length) delete f.b;
  if (!f.foule.length) delete f.foule;
  if (!f.mots.length) delete f.mots;
  return f;
}

const hhmm = ts => new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).replace(":", "h");
const fmt = n => n >= 1000 ? n.toLocaleString("fr-FR").replace(/\u202f/g, " ") : String(n);

export function buildVersions(e) {
  const arts = [...e.articles].sort((a, b) => a.date - b.date);
  const v = { divergences: [], frames: [], foule: [], chrono: [], resume: "" };
  // chronologie : ce que chaque nouvel article apporte
  const seen = {};
  for (const a of arts) {
    const add = [];
    for (const [k, n] of Object.entries(a.f?.b || {})) if (n !== seen[k]) { add.push(`${METRICS[k].toLowerCase()} : ${fmt(n)}`); seen[k] = n; }
    for (const x of a.f?.foule || []) add.push(`${fmt(x.n)} selon ${x.who === "police" ? "la police" : x.who === "organisateurs" ? "les organisateurs" : "un comptage indépendant"}`);
    v.chrono.push({ t: a.date, src: a.src, add: add.slice(0, 4) });
  }
  // chiffres qui divergent entre deux sources publiées à moins de 3 h d'écart
  for (const k of Object.keys(METRICS)) {
    const vals = arts.filter(a => a.f?.b?.[k] != null).map(a => ({ v: a.f.b[k], src: a.src, t: a.date }));
    if (vals.length < 2) continue;
    let conflict = false;
    for (let i = 0; i < vals.length && !conflict; i++) for (let j = i + 1; j < vals.length; j++)
      if (vals[i].src !== vals[j].src && vals[i].v !== vals[j].v && (Math.abs(vals[i].t - vals[j].t) < 3600e3 || (vals[j].v < vals[i].v && vals[j].t - vals[i].t < 6 * 3600e3))) { conflict = true; break; }
    const rising = vals.every((x, i) => i === 0 || x.v >= vals[i - 1].v) && vals[vals.length - 1].v > vals[0].v;
    v.divergences.push({ k, label: METRICS[k], conflict, rising: !conflict && rising, values: vals.map(x => ({ v: x.v, src: x.src, t: x.t })) });
  }
  // foule selon qui
  const fb = {};
  for (const a of arts) for (const x of a.f?.foule || []) { const key = x.who; if (!fb[key] || a.date > fb[key].t) fb[key] = { n: x.n, who: x.who, src: a.src, t: a.date }; }
  v.foule = Object.values(fb);
  // mots employés par source, et récits opposés
  const bySide = {};
  for (const [id, label, , side] of FRAMES) {
    const srcs = [...new Set(arts.filter(a => a.f?.mots?.includes(id)).map(a => a.src))];
    if (!srcs.length) continue;
    v.frames.push({ id, label, srcs, side });
    if (side) { const st = (bySide[side] = bySide[side] || new Set()); srcs.forEach(x => st.add(x)); }
  }
  v.opposed = [];
  for (const [x, y] of OPPOSED) {
    if (!bySide[x] || !bySide[y]) continue;
    const ax = [...bySide[x]], by = [...bySide[y]];
    if (ax.some(s => !by.includes(s)) || by.some(s => !ax.includes(s)))
      v.opposed.push({ a: v.frames.filter(f => f.side === x).map(f => f.label), b: v.frames.filter(f => f.side === y).map(f => f.label), srcA: ax, srcB: by });
  }
  v.conflict = v.divergences.some(d => d.conflict) || v.opposed.length > 0 || (v.foule.length > 1 && Math.max(...v.foule.map(f => f.n)) > 2 * Math.min(...v.foule.map(f => f.n)));
  // résumé automatique, factuel, recalculé à chaque article
  const first = arts[0], last = arts[arts.length - 1];
  const parts = [`${e.place ? e.place + " · " : ""}${e.type}. Premier signalement à ${hhmm(first.date)} (${first.src})${arts.length > 1 ? `, ${arts.length} articles de ${new Set(arts.map(a => a.src)).size} sources depuis, le dernier à ${hhmm(last.date)}` : ""}.`];
  const latest = {};
  for (const a of arts) for (const [k, n] of Object.entries(a.f?.b || {})) latest[k] = { n, src: a.src };
  const lb = Object.entries(latest).map(([k, x]) => `${fmt(x.n)} ${METRICS[k].toLowerCase()}`);
  if (lb.length) parts.push(`Dernier bilan relevé : ${lb.join(", ")}.`);
  if (v.foule.length) parts.push(`Foule : ${v.foule.map(f => `${fmt(f.n)} selon ${f.who === "police" ? "la police" : f.who === "organisateurs" ? "les organisateurs" : "un comptage indépendant"}`).join(", ")}.`);
  const dv = v.divergences.filter(d => d.conflict).map(d => d.label.toLowerCase());
  if (dv.length) parts.push(`Les sources ne donnent pas les mêmes chiffres (${dv.join(", ")}).`);
  if (v.opposed.length) parts.push(`Les médias ne racontent pas le fait avec les mêmes mots : ${v.opposed.map(o => `« ${o.a[0]} » d'un côté, « ${o.b[0]} » de l'autre`).join(" ; ")}.`);
  v.resume = parts.join(" ");
  return v;
}

export async function analyzeVersions(events, { now, maxFetch = 24, log = () => {} }) {
  let fetched = 0, built = 0;
  const todo = events.filter(e => now - (e.updated || e.date) < 48 * 3600e3 && (e.articles.length >= 2 || e.kind === "manif"));
  for (const e of todo) {
    let changed = false;
    for (const a of e.articles) {
      if (a.fx) continue;
      let txt = a.t;
      if (fetched < maxFetch && !/news\.google\.|bsky\.app/.test(a.url)) { const body = await articleText(a.url); if (body) { txt += " " + body; fetched++; } }
      a.f = factsOf(txt); a.fx = 1; changed = true;
    }
    if (changed || !e.versions) { e.versions = buildVersions(e); built++; }
  }
  if (built) log(`  versions : ${built} fiche(s) mise(s) à jour, ${fetched} article(s) lus`);
}
