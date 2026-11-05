// POST /api/fuente — reads a link the participant shares (article, web page, YouTube, Spotify)
// and stores what it could read as a text source for the interview.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { adminClient, allowMethods, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";

const BUCKET = "artefactos";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 150_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPrivateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Only public http(s) addresses on default ports, so a shared link can never reach internal services. */
export async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, "El enlace no es válido."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new HttpError(400, "Solo puedo leer enlaces web normales (http o https).");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new HttpError(400, "No puedo leer ese enlace.");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new HttpError(400, "No encuentro esa dirección web."); });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, "No puedo leer ese enlace.");
  return url;
}

async function fetchPublic(raw, accept) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { redirect: "manual", headers: { Accept: accept, "User-Agent": "LumenBot/1.0 (+lectura de enlaces compartidos por participantes)" }, signal: AbortSignal.timeout(8000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location"), url).toString());
      continue;
    }
    if (!res.ok) throw new HttpError(422, "La página no se pudo abrir.");
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); break; }
      chunks.push(value);
    }
    return { url, type: res.headers.get("content-type") || "", body: Buffer.concat(chunks).toString("utf8") };
  }
  throw new HttpError(422, "La página redirige demasiadas veces.");
}

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const meta = (html, name) => decode(html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)`, "i"))?.[1] || "").trim();

export function readableText(html) {
  const main = html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html;
  return decode(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|section|br|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

async function readLink(raw) {
  const host = new URL(raw).hostname.replace(/^www\./, "");
  const oembed = /(^|\.)youtube\.com$|^youtu\.be$/.test(host) ? { api: "https://www.youtube.com/oembed?format=json&url=", plataforma: "YouTube", tipo: "video" }
    : host === "open.spotify.com" ? { api: "https://open.spotify.com/oembed?url=", plataforma: "Spotify", tipo: "audio" } : null;
  if (oembed) {
    const { body } = await fetchPublic(oembed.api + encodeURIComponent(raw), "application/json");
    let o = {};
    try { o = JSON.parse(body); } catch {}
    const titulo = o.title || `${oembed.plataforma}: contenido sin título`;
    return { titulo, tipo: oembed.tipo, leido: false,
      texto: `Contenido de ${oembed.plataforma} (${oembed.tipo === "video" ? "vídeo" : "audio o pódcast"}). Lumen no puede verlo ni escucharlo; solo conoce estos datos.\nTítulo: ${titulo}\n${o.author_name ? `Autor o canal: ${o.author_name}\n` : ""}Enlace: ${raw}` };
  }
  const { type, body } = await fetchPublic(raw, "text/html,text/plain;q=0.9");
  if (!/text\/(html|plain)|xhtml/i.test(type)) throw new HttpError(415, "Ese enlace no es una página que pueda leer. Si es un PDF, descárgalo y adjúntalo con el clip.");
  const isHtml = /html/i.test(type);
  const titulo = (isHtml ? meta(body, "og:title") || decode(body.match(/<title[^>]*>([^<]*)/i)?.[1] || "") : "").trim() || host;
  const texto = (isHtml ? readableText(body) : body).slice(0, MAX_CHARS);
  const autor = isHtml ? meta(body, "author") || meta(body, "article:author") : "";
  if (texto.length < 600) {
    return { titulo, tipo: "web", leido: false, texto: `Página web de la que Lumen no pudo leer el texto (puede requerir suscripción o registro).\nTítulo: ${titulo}\n${autor ? `Autor: ${autor}\n` : ""}Enlace: ${raw}` };
  }
  return { titulo, tipo: "web", leido: true, texto: `Título: ${titulo}\n${autor ? `Autor: ${autor}\n` : ""}Enlace: ${raw}\n\n${texto}` };
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    await requireConsentedProfile(user.id);
    const body = readJson(req);
    const raw = String(body.url || "").trim().slice(0, 2000);
    if (!UUID.test(String(body.draftId || ""))) throw new HttpError(400, "Falta la entrevista a la que pertenece el enlace.");
    const leido = await readLink(raw);
    const path = `${user.id}/fuentes/${body.draftId}/enlace-${Date.now()}.txt`;
    const { error } = await adminClient().storage.from(BUCKET).upload(path, new Blob([leido.texto], { type: "text/plain;charset=utf-8" }), { contentType: "text/plain;charset=utf-8" });
    if (error) throw new HttpError(500, "No se pudo guardar el contenido del enlace.");
    res.status(200).json({ fuente: { name: leido.titulo.slice(0, 200), path, tipo: leido.tipo, url: raw, leido: leido.leido } });
  } catch (err) {
    if (err?.name === "TimeoutError") err = new HttpError(504, "La página tardó demasiado en responder.");
    sendError(res, err);
  }
}
