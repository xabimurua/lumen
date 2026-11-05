// Source material a participant attaches to an interview (a PDF or a text file),
// loaded from their private storage folder and turned into a Claude document block.
import { adminClient, HttpError } from "./server.js";

const BUCKET = "artefactos";
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 300_000;

/** Returns a cacheable document block for the participant's source, or null when none was attached. */
export async function loadSource(userId, fuente) {
  if (!fuente?.path) return null;
  const path = String(fuente.path);
  if (!path.startsWith(`${userId}/fuentes/`) || path.includes("..")) throw new HttpError(400, "El contenido adjunto no es válido.");
  const { data, error } = await adminClient().storage.from(BUCKET).download(path);
  if (error || !data) throw new HttpError(404, "No encuentro el contenido que adjuntaste. Vuelve a adjuntarlo.");

  const title = String(fuente.name || "Contenido de la persona").slice(0, 200);
  const isPdf = data.type === "application/pdf" || /\.pdf$/i.test(path);
  if (isPdf) {
    if (data.size > MAX_PDF_BYTES) throw new HttpError(413, "El PDF supera los 10 MB. Adjunta solo la parte relevante.");
    const b64 = Buffer.from(await data.arrayBuffer()).toString("base64");
    return { type: "document", title, source: { type: "base64", media_type: "application/pdf", data: b64 }, cache_control: { type: "ephemeral" } };
  }
  const text = (await data.text()).slice(0, MAX_TEXT_CHARS);
  if (!text.trim()) throw new HttpError(400, "El archivo adjunto está vacío.");
  return { type: "document", title, source: { type: "text", media_type: "text/plain", data: text }, cache_control: { type: "ephemeral" } };
}
