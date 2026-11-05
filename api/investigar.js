// POST /api/investigar — searches the web for what the participant mentions and stores a context sheet
// (with its sources) that the interview then uses alongside any attached material.
import { adminClient, allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { researchReference } from "../lib/claude.js";

const BUCKET = "artefactos";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    await requireConsentedProfile(user.id);
    const body = readJson(req);
    const texto = String(body.texto || "").trim().slice(0, 2000);
    if (!texto) throw new HttpError(400, "Falta el texto que hay que investigar.");
    if (!UUID.test(String(body.draftId || ""))) throw new HttpError(400, "Falta la entrevista a la que pertenece la búsqueda.");
    const conversacion = String(body.conversacion || "").slice(-3000);
    // Each new search adds to the interview's context sheet instead of replacing it.
    const admin = adminClient();
    const prefix = `${user.id}/fuentes/${body.draftId}/`;
    let previo = "";
    if (typeof body.previo === "string" && body.previo.startsWith(prefix) && !body.previo.includes("..")) {
      const { data } = await admin.storage.from(BUCKET).download(body.previo);
      if (data) previo = (await data.text()) + "\n\n---\n\n";
    }
    await chargeAiCall(user.id);
    const r = await researchReference({ texto, conversacion, yaBuscado: previo.slice(0, 4000) });
    if (r.nada) return res.status(200).json({ nada: true });
    const bloque = `Búsqueda: «${texto.slice(0, 200)}»\n${r.ficha}\n\nFuentes:\n${r.fuentes.map((f) => `- ${f.title}: ${f.url}`).join("\n")}`;
    const cabecera = previo ? "" : "Ficha de contexto elaborada por Lumen con búsquedas en internet. Puede contener errores o referirse a otra entidad con el mismo nombre: la persona debe confirmarla.\n\n";
    const path = `${prefix}contexto-${Date.now()}.txt`;
    const { error } = await admin.storage.from(BUCKET).upload(path, new Blob([cabecera + previo + bloque], { type: "text/plain;charset=utf-8" }), { contentType: "text/plain;charset=utf-8" });
    if (error) throw new HttpError(500, "No se pudo guardar la ficha de contexto.");
    res.status(200).json({ nada: false, resumen: r.resumen, fuentes: r.fuentes, contexto: { path, name: "Contexto buscado en internet" } });
  } catch (err) {
    sendError(res, err);
  }
}
