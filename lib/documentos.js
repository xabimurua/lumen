// Turns what participants and coordinators share (a public URL or a file in their storage folder)
// into a content block Claude can read: PDF, image or plain text.
import { adminClient, HttpError } from "./server.js";
import { fetchPublic, MAX_CHARS, readableText, readLinkedArticles } from "./web.js";
import { readPageWithClaude } from "./claude.js";

const BUCKET = "artefactos";
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_EXT = /\.(txt|md|csv|json|eml|html?|xml|ics|vtt|srt)$/i;

const isPdf = (type, bytes, name) => /pdf/i.test(type) || /\.pdf$/i.test(name) || bytes.subarray(0, 5).toString() === "%PDF-";

function blockFromBytes(bytes, type, name, title) {
  if (isPdf(type, bytes, name)) {
    if (bytes.length > MAX_PDF_BYTES) throw new HttpError(413, "El PDF supera los 10 MB, así que Lumen no puede leerlo entero.");
    return { type: "document", title, source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } };
  }
  const ext = (name.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
  const imageType = IMAGE_TYPES[ext] || (/^image\/(png|jpeg|gif|webp)/i.test(type) ? type.split(";")[0] : "");
  if (imageType) {
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "La imagen supera los 5 MB, así que Lumen no puede revisarla.");
    return { type: "image", source: { type: "base64", media_type: imageType, data: bytes.toString("base64") } };
  }
  if (/^text\/|json|xml|message\/rfc822/i.test(type) || TEXT_EXT.test(name)) {
    const raw = bytes.toString("utf8");
    const text = (/html/i.test(type) || /\.html?$/i.test(name) ? readableText(raw) : raw).slice(0, MAX_CHARS);
    if (!text.trim()) throw new HttpError(422, "El archivo está vacío.");
    return { type: "document", title, source: { type: "text", media_type: "text/plain", data: text } };
  }
  throw new HttpError(415, "Lumen no puede leer este tipo de archivo (sí PDF, imágenes, texto y correos .eml). Queda guardado como prueba igualmente.");
}

/** A file the participant uploaded to their own storage folder. */
export async function documentFromStorage(userId, path, title) {
  if (typeof path !== "string" || !path.startsWith(`${userId}/`) || path.includes("..")) throw new HttpError(400, "El archivo no es válido.");
  const { data, error } = await adminClient().storage.from(BUCKET).download(path);
  if (error || !data) throw new HttpError(404, "No encuentro ese archivo.");
  return blockFromBytes(Buffer.from(await data.arrayBuffer()), data.type || "", path, title);
}

/** A public web page or document. */
export async function documentFromUrl(url, title, { minChars = 300 } = {}) {
  const { type, bytes, body } = await fetchPublic(url, "application/pdf,text/html;q=0.9,text/plain;q=0.8,image/*;q=0.7");
  const name = new URL(url).pathname;
  if (/html/i.test(type)) {
    const text = readableText(body).slice(0, MAX_CHARS);
    if (text.length >= minChars) {
      const enlazados = await readLinkedArticles(body, url, { max: 8, budget: MAX_CHARS - text.length });
      const data = enlazados.count ? `${text}\n\n## Artículos enlazados desde la página (${enlazados.count})\n\n${enlazados.texto}` : text;
      return { type: "document", title, source: { type: "text", media_type: "text/plain", data } };
    }
    const leido = await readPageWithClaude(url);
    if (leido.length < minChars) throw new HttpError(422, "No he podido leer el texto de esa página (puede requerir iniciar sesión). Guárdala como PDF desde el navegador y adjúntala.");
    return { type: "document", title, source: { type: "text", media_type: "text/plain", data: leido.slice(0, MAX_CHARS) } };
  }
  return blockFromBytes(bytes, type, name, title);
}
