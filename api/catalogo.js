// POST /api/catalogo — coordinators only: reads an official teaching guide (URL or pasted text)
// and returns the subject's data and learning outcomes for review before publishing.
import { allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { extractSubject } from "../lib/claude.js";
import { fetchPublic, MAX_CHARS, readableText } from "../lib/web.js";

const MAX_PDF_BYTES = 10 * 1024 * 1024;

async function guideDocument(url, texto) {
  if (texto) return { type: "document", title: "Guía docente", source: { type: "text", media_type: "text/plain", data: texto.slice(0, MAX_CHARS) } };
  const { type, bytes, body } = await fetchPublic(url, "application/pdf,text/html;q=0.9,text/plain;q=0.8");
  if (/pdf/i.test(type) || bytes.subarray(0, 5).toString() === "%PDF-") {
    if (bytes.length > MAX_PDF_BYTES) throw new HttpError(413, "El PDF de la guía supera los 10 MB.");
    return { type: "document", title: "Guía docente", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } };
  }
  if (!/text\/(html|plain)|xhtml/i.test(type)) throw new HttpError(415, "Ese enlace no es una página ni un PDF.");
  const text = (/html/i.test(type) ? readableText(body) : body).slice(0, MAX_CHARS);
  if (text.length < 300) throw new HttpError(422, "No he podido leer el texto de esa página. Pega el texto de la guía docente.");
  return { type: "document", title: "Guía docente", source: { type: "text", media_type: "text/plain", data: text } };
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    const perfil = await requireConsentedProfile(user.id);
    if (perfil.role !== "coordinador") throw new HttpError(403, "Solo la coordinación puede gestionar el catálogo.");
    const body = readJson(req);
    const url = String(body.url || "").trim().slice(0, 2000);
    const texto = String(body.texto || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "Indica la URL oficial de la guía docente: queda como fuente de la asignatura.");
    const fuente = await guideDocument(url, texto);
    await chargeAiCall(user.id);
    const datos = await extractSubject({ fuente });
    if (!datos.es_guia_docente) throw new HttpError(422, "Ese documento no parece la guía docente de una asignatura.");
    res.status(200).json({ ...datos, resultados: datos.resultados.map((t) => t.trim()).filter(Boolean), fuente_url: url });
  } catch (err) {
    if (err?.name === "TimeoutError") err = new HttpError(504, "La página tardó demasiado en responder.");
    sendError(res, err);
  }
}
