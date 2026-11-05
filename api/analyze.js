// POST /api/analyze — structured analyses: closing an interview, linking a diary entry, extracting outcomes.
import { adminClient, allowMethods, chargeAiCall, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { analyzeInterview, discoverSubjects, extractOutcomes, linkDiary, parseHistory, proposeAccreditations, CONTEXTOS } from "../lib/claude.js";
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
      const [fuente, contexto] = await Promise.all([loadSource(user.id, body.fuente), loadSource(user.id, body.contexto)]);
      await chargeAiCall(user.id);
      const out = await analyzeInterview({ objetivo: perfil.objetivo, titulo: String(body.titulo || "").slice(0, 300), history, today, fuente, contexto });
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
        admin.from("catalogo_asignaturas").select("id,universidad,titulacion,nivel,asignatura,ects,resultados,fuente_url,estado").in("estado", ["publicada", "detectada"]).limit(150),
      ]);
      if (error || catErr) throw new HttpError(500, "No se pudieron leer tus evidencias o el catálogo.");
      const evidencias = rows.map((r) => r.data);
      if (!intencion && evidencias.length < 2) throw new HttpError(400, "Documenta al menos dos aprendizajes para que Lumen pueda proponerte acreditaciones.");
      await chargeAiCall(user.id);
      const origen = intencion ? "usuario" : "lumen";
      let out = await proposeAccreditations({ intencion, evidencias, catalogo });

      // Nothing in the catalog fits (or the person asked for something it lacks): find real subjects at
      // Spanish universities, store them as "detectada" for Lumen's team, and propose from them.
      if (!out.propuestas.length || (intencion && out.sin_coincidencia) || body.ampliar === true) {
        await chargeAiCall(user.id);
        const encontradas = await discoverSubjects({ intencion, evidencias });
        const conocidas = new Map(catalogo.map((c) => [c.fuente_url, c]));
        const nuevas = [];
        for (const a of encontradas) {
          if (conocidas.has(a.fuente_url)) { nuevas.push(conocidas.get(a.fuente_url)); continue; }
          const row = { ...a, resultados: a.resultados.map((t, i) => ({ id: "RA" + (i + 1), texto: t })), estado: "detectada", detectada_por: user.id, created_by: null };
          const { data: ins, error: insErr } = await admin.from("catalogo_asignaturas").insert(row).select("id,universidad,titulacion,nivel,asignatura,ects,resultados,fuente_url,estado").single();
          if (!insErr && ins) nuevas.push(ins);
        }
        if (nuevas.length) {
          await chargeAiCall(user.id);
          const extra = await proposeAccreditations({ intencion, evidencias, catalogo: nuevas });
          const ya = new Set(out.propuestas.map((p) => p.asignatura_id));
          out = { propuestas: [...out.propuestas, ...extra.propuestas.filter((p) => !ya.has(p.asignatura_id))].slice(0, 4), sin_coincidencia: extra.propuestas.length ? "" : out.sin_coincidencia || extra.sin_coincidencia };
        }
      }
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
