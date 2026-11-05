// POST /api/catalogo — coordinators only: reads an official teaching guide (URL or pasted text)
// and returns the subject's data and learning outcomes for review before publishing.
import { allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { extractSubject } from "../lib/claude.js";
import { MAX_CHARS } from "../lib/web.js";
import { documentFromUrl } from "../lib/documentos.js";

async function guideDocument(url, texto) {
  if (texto) return { type: "document", title: "Guía docente", source: { type: "text", media_type: "text/plain", data: texto.slice(0, MAX_CHARS) } };
  const doc = await documentFromUrl(url, "Guía docente");
  if (doc.type !== "document") throw new HttpError(415, "Ese enlace no es una página ni un PDF.");
  return doc;
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
