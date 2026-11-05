// POST /api/fuente — reads a link the participant shares (article, web page, YouTube, Spotify)
// and stores what it could read as a text source for the interview.
import { decode, fetchPublic, MAX_CHARS, meta, readableText } from "../lib/web.js";
import { readPageWithClaude } from "../lib/claude.js";
import { adminClient, chargeAiCall, allowMethods, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";

const BUCKET = "artefactos";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

async function readLink(raw, userId) {
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
  const { type, body: full } = await fetchPublic(raw, "text/html,text/plain;q=0.9");
  const body = full.slice(0, MAX_PAGE_BYTES);
  if (!/text\/(html|plain)|xhtml/i.test(type)) throw new HttpError(415, "Ese enlace no es una página que pueda leer. Si es un PDF, descárgalo y adjúntalo con el clip.");
  const isHtml = /html/i.test(type);
  const titulo = (isHtml ? meta(body, "og:title") || decode(body.match(/<title[^>]*>([^<]*)/i)?.[1] || "") : "").trim() || host;
  const texto = (isHtml ? readableText(body) : body).slice(0, MAX_CHARS);
  const autor = isHtml ? meta(body, "author") || meta(body, "article:author") : "";
  if (texto.length < 200) {
    await chargeAiCall(userId);
    const leidoPorClaude = await readPageWithClaude(raw);
    if (leidoPorClaude.length >= 200) return { titulo, tipo: "web", leido: true, texto: `Título: ${titulo}\n${autor ? `Autor: ${autor}\n` : ""}Enlace: ${raw}\n\n${leidoPorClaude.slice(0, MAX_CHARS)}` };
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
    const leido = await readLink(raw, user.id);
    const path = `${user.id}/fuentes/${body.draftId}/enlace-${Date.now()}.txt`;
    const { error } = await adminClient().storage.from(BUCKET).upload(path, new Blob([leido.texto], { type: "text/plain;charset=utf-8" }), { contentType: "text/plain;charset=utf-8" });
    if (error) throw new HttpError(500, "No se pudo guardar el contenido del enlace.");
    res.status(200).json({ fuente: { name: leido.titulo.slice(0, 200), path, tipo: leido.tipo, url: raw, leido: leido.leido } });
  } catch (err) {
    if (err?.name === "TimeoutError") err = new HttpError(504, "La página tardó demasiado en responder.");
    sendError(res, err);
  }
}
