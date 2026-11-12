// POST /api/analyze — structured analyses: closing an interview, linking a diary entry, extracting outcomes.
import { adminClient, allowMethods, chargeAiCall, objetivoDe, readJson, requireConsentedProfile, requireUser, sendError, HttpError } from "../lib/server.js";
import { analyzeInterview, discoverSubjects, extractOutcomes, linkDiary, parseHistory, proposeAccreditations, quickQuestions, CONTEXTOS } from "../lib/claude.js";
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
      const out = await analyzeInterview({ objetivo: await objetivoDe(user.id, body.acreditacion_id), titulo: String(body.titulo || "").slice(0, 300), history, today, fuente, contexto });
      return res.status(200).json(out);
    }
    if (body.kind === "preguntas") {
      const titulo = String(body.titulo || "").trim().slice(0, 300);
      if (!titulo) throw new HttpError(400, "Falta la evidencia.");
      await chargeAiCall(user.id);
      return res.status(200).json({ preguntas: await quickQuestions({ objetivo: await objetivoDe(user.id, body.acreditacion_id), titulo, resumen: String(body.resumen || "").slice(0, 2000) }) });
    }
    if (body.kind === "diary") {
      const texto = String(body.texto || "").trim().slice(0, 4000);
      if (!texto) throw new HttpError(400, "La entrada del diario está vacía.");
      const contexto = CONTEXTOS.includes(body.contexto) ? body.contexto : "";
      await chargeAiCall(user.id);
      const out = await linkDiary({ objetivo: await objetivoDe(user.id, body.acreditacion_id), texto, contexto, horas: Number(body.horas) || 0 });
      return res.status(200).json(out);
    }
    // A new evidence, linked to the learning outcomes of every accreditation in the person's tree.
    if (body.kind === "vincular") {
      const texto = String(body.texto || "").trim().slice(0, 6000);
      if (!texto) throw new HttpError(400, "Falta la evidencia.");
      const excluir = new Set(Array.isArray(body.excluir) ? body.excluir.map(String) : []);
      const { data: acs, error } = await adminClient().from("acreditaciones").select("id, catalogo_asignaturas(asignatura, titulacion, universidad, resultados)").eq("user_id", user.id).eq("estado", "activa").limit(8);
      if (error) throw new HttpError(500, "No se pudieron leer tus acreditaciones.");
      const contexto = CONTEXTOS.includes(body.contexto) ? body.contexto : "";
      const vinculos = {};
      for (const a of (acs || []).filter((x) => !excluir.has(x.id) && x.catalogo_asignaturas?.resultados?.length)) {
        await chargeAiCall(user.id);
        const o = await linkDiary({ objetivo: { ...a.catalogo_asignaturas, generico: false }, texto, contexto, horas: Number(body.horas) || 0 });
        if (o.resultados?.length) vinculos[a.id] = o.resultados;
      }
      return res.status(200).json({ vinculos });
    }
    // Which of the person's evidences back each learning outcome of one accreditation.
    if (body.kind === "relink") {
      const obj = await objetivoDe(user.id, body.acreditacion_id);
      const { data: rows, error } = await adminClient().from("evidencias").select("data").eq("user_id", user.id).order("created_at");
      if (error) throw new HttpError(500, "No se pudieron leer tus evidencias.");
      const evidencias = rows.map((r) => r.data);
      if (!evidencias.length || !obj.resultados?.length) return res.status(200).json({ cobertura: [] });
      await chargeAiCall(user.id);
      const out = await proposeAccreditations({ intencion: `${obj.asignatura} (${obj.titulacion}, ${obj.universidad})`, evidencias, catalogo: [{ ...obj, id: obj.asignatura_id }] });
      return res.status(200).json({ cobertura: out.propuestas.find((p) => p.asignatura_id === obj.asignatura_id)?.cobertura || [] });
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
