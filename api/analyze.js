// POST /api/analyze — structured analyses: closing an interview, linking a diary entry, extracting outcomes.
import { adminClient, allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { analyzeInterview, extractOutcomes, linkDiary, parseHistory, proposeAccreditations, CONTEXTOS } from "../lib/claude.js";
import { randomUUID } from "node:crypto";
import { loadSource } from "../lib/fuente.js";

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;
  try {
    const user = await requireUser(req);
    const perfil = await requireConsentedProfile(user.id);
    const body = readJson(req);
    const today = new Date().toISOString().slice(0, 10);

    if (body.kind === "interview") {
      const history = parseHistory(body.history);
      const fuente = await loadSource(user.id, body.fuente);
      await chargeAiCall(user.id);
      const out = await analyzeInterview({ objetivo: perfil.objetivo, titulo: String(body.titulo || "").slice(0, 300), history, today, fuente });
      return res.status(200).json(out);
    }
    if (body.kind === "diary") {
      const texto = String(body.texto || "").trim().slice(0, 4000);
      if (!texto) throw new HttpError(400, "La entrada del diario está vacía.");
      const contexto = CONTEXTOS.includes(body.contexto) ? body.contexto : "";
      await chargeAiCall(user.id);
      const out = await linkDiary({ objetivo: perfil.objetivo, texto, contexto, horas: Number(body.horas) || 0 });
      return res.status(200).json(out);
    }
    if (body.kind === "extract") {
      const guia = String(body.guia || "").trim().slice(0, 30000);
      if (!guia) throw new HttpError(400, "Pega primero el texto de la guía docente.");
      await chargeAiCall(user.id);
      return res.status(200).json({ resultados: await extractOutcomes(guia) });
    }
    if (body.kind === "propose") {
      const intencion = String(body.intencion || "").trim().slice(0, 1000);
      const admin = adminClient();
      const [{ data: rows, error }, { data: catalogo, error: catErr }] = await Promise.all([
        admin.from("evidencias").select("data").eq("user_id", user.id).order("created_at"),
        admin.from("catalogo_asignaturas").select("id,universidad,titulacion,nivel,asignatura,ects,resultados,fuente_url").eq("estado", "publicada").limit(150),
      ]);
      if (error || catErr) throw new HttpError(500, "No se pudieron leer tus evidencias o el catálogo.");
      const evidencias = rows.map((r) => r.data);
      if (!intencion && evidencias.length < 2) throw new HttpError(400, "Documenta al menos dos aprendizajes para que Lumen pueda proponerte acreditaciones.");
      if (!catalogo.length) throw new HttpError(409, "Todavía no hay asignaturas en el catálogo oficial de Lumen. La coordinación tiene que añadirlas.");
      await chargeAiCall(user.id);
      const origen = intencion ? "usuario" : "lumen";
      const out = await proposeAccreditations({ intencion, evidencias, catalogo });
      const nuevas = out.propuestas.map((p) => ({ ...p, id: randomUUID(), creada: new Date().toISOString(), origen, intencion, estado: "nueva" }));
      const anteriores = (perfil.propuestas || []).filter((p) => p.asignatura_id && (p.estado === "adoptada" || (p.estado === "nueva" && p.origen !== origen)));
      const propuestas = [...nuevas, ...anteriores].slice(0, 8);
      const { error: upErr } = await admin.from("perfiles").update({ propuestas, propuestas_n_evidencias: evidencias.length }).eq("user_id", user.id);
      if (upErr) throw new HttpError(500, "No se pudieron guardar las propuestas.");
      return res.status(200).json({ propuestas, sin_coincidencia: out.sin_coincidencia });
    }
    throw new HttpError(400, "Tipo de análisis desconocido.");
  } catch (err) {
    sendError(res, err);
  }
}
