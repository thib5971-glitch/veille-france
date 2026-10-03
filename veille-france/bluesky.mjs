// Source Bluesky : recherche des posts récents en français.
// Les comptes « vérifiés par domaine » des médias (ex. @lemonde.fr) comptent comme une vraie source ;
// les autres comptes servent seulement de témoignages rattachés à un fait déjà connu.
const API_PUBLIC = "https://api.bsky.app/xrpc/";
const UA = "VeilleFrance/1.0 (carte d'actualité)";

export const DEFAULT_TRUSTED = [
  "afp.com", "lemonde.fr", "liberation.fr", "lefigaro.fr", "leparisien.fr", "francetvinfo.fr", "franceinfo.fr", "radiofrance.fr",
  "francebleu.fr", "ici.fr", "france3-regions.fr", "mediapart.fr", "humanite.fr", "la-croix.com", "nouvelobs.com", "lexpress.fr",
  "lepoint.fr", "20minutes.fr", "ouest-france.fr", "sudouest.fr", "ladepeche.fr", "laprovence.com", "ledauphine.com", "leprogres.fr",
  "lavoixdunord.fr", "estrepublicain.fr", "dna.fr", "lalsace.fr", "republicain-lorrain.fr", "midilibre.fr", "nicematin.com",
  "varmatin.com", "letelegramme.fr", "courrier-picard.fr", "paris-normandie.fr", "lamontagne.fr", "leberry.fr", "actu.fr",
  "bfmtv.com", "rfi.fr", "tf1info.fr", "lci.fr", "streetpress.com", "brut.media", "konbini.com", "reporterre.net", "rue89strasbourg.com",
  "mediacites.fr", "marsactu.fr", "lyonmag.com", "lyoncapitale.fr", "actu17.fr"
];

async function session(handle, pass) {
  const r = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ identifier: handle, password: pass }), signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error("connexion Bluesky " + r.status);
  return (await r.json()).accessJwt;
}

function toItem(p, trusted) {
  const handle = p.author?.handle || "", rkey = (p.uri || "").split("/").pop();
  const text = (p.record?.text || "").replace(/\s+/g, " ").trim();
  if (!text || !rkey) return null;
  const isTrusted = trusted.some(d => handle === d || handle.endsWith("." + d));
  const ext = p.embed?.external || p.record?.embed?.external;
  // pour un média, on préfère le titre et le lien de l'article partagé quand il y en a un
  const title = isTrusted && ext?.title ? ext.title : text.slice(0, 220);
  const link = isTrusted && ext?.uri && /^https?:\/\//.test(ext.uri) ? ext.uri : `https://bsky.app/profile/${handle}/post/${rkey}`;
  return {
    title, link, desc: (isTrusted ? text + " " + (ext?.description || "") : text).slice(0, 500),
    src: isTrusted ? (p.author?.displayName || handle) + " (Bluesky)" : "Bluesky",
    date: Math.min(Date.parse(p.record?.createdAt || p.indexedAt) || Date.now(), Date.now()),
    bsky: true, trusted: isTrusted, post: `https://bsky.app/profile/${handle}/post/${rkey}`
  };
}

export async function fetchBluesky(cfg = {}, env = process.env, log = () => {}) {
  const queries = cfg.queries || ["manifestation", "manif", "rassemblement", "cortège", "intervention en cours", "fusillade", "blocage", "émeutes"];
  const trusted = [...DEFAULT_TRUSTED, ...(cfg.trustedDomains || [])];
  let base = API_PUBLIC, headers = { "User-Agent": UA, "Accept": "application/json" };
  if (env.BSKY_HANDLE && env.BSKY_APP_PASSWORD) {
    try { headers.Authorization = "Bearer " + await session(env.BSKY_HANDLE, env.BSKY_APP_PASSWORD); base = "https://bsky.social/xrpc/"; }
    catch (e) { log("  Bluesky :", e.message, "→ recherche sans compte"); }
  }
  const out = [], seen = new Set(); let ok = 0, fail = 0;
  if (env.BSKY_FILE) { const fs = await import("node:fs/promises"); return (JSON.parse(await fs.readFile(env.BSKY_FILE, "utf8")).posts || []).map(p => toItem(p, trusted)).filter(Boolean); }
  for (const q of queries) {
    const p = new URLSearchParams({ q, lang: "fr", sort: "latest", limit: "100" });
    try {
      const r = await fetch(base + "app.bsky.feed.searchPosts?" + p, { headers, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { fail++; continue; }
      ok++;
      for (const post of (await r.json()).posts || []) {
        if (seen.has(post.uri)) continue; seen.add(post.uri);
        const it = toItem(post, trusted); if (it) out.push(it);
      }
    } catch { fail++; }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!ok) throw new Error(`recherche refusée (${fail} essais)${headers.Authorization ? "" : " : ajoute BSKY_HANDLE et BSKY_APP_PASSWORD"}`);
  return out;
}
