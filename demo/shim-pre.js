// Demo backend for claude.ai: an in-browser stand-in for Supabase and the /api routes.
// The production app.js runs unchanged on top of it.
(function () {
  const KEY = "lumen_demo_v3";
  const CAT1 = "c0000000-0000-4000-8000-000000000001";
  const ME = "00000000-0000-4000-8000-000000000001";
  const OTHER = "00000000-0000-4000-8000-000000000002";
  const use = (n) => (window.claude?.use ? window.claude.use(n) : Promise.resolve(null));

  function seed() {
    return {
      session: null,
      perfiles: [
        { user_id: ME, nombre: "", role: "coordinador", consentimiento_at: null, consentimiento_version: null, compartir_con_coordinacion: false, objetivo: {}, created_at: new Date().toISOString() },
        { user_id: OTHER, nombre: "Participante de ejemplo", role: "participante", consentimiento_at: "2026-10-01T09:00:00Z", consentimiento_version: "piloto-v1", compartir_con_coordinacion: true, objetivo: {}, created_at: "2026-10-01T09:00:00Z" },
      ],
      evidencias: [
        { id: "e0000000-0000-4000-8000-000000000001", user_id: OTHER, created_at: "2026-10-05T18:00:00Z", data: { id: "e0000000-0000-4000-8000-000000000001", kind: "evidence", tipo: "entrevista", titulo: "Coordinación de un banco de alimentos (ejemplo)", fecha: "2026-09-20", createdAt: 1, contexto: "Voluntariado", horas: 20, resultados: [], vinculos: { "a0000000-0000-4000-8000-000000000002": ["RA1", "RA3"] }, evidencias: { idea: "Explica cómo organizó turnos de 15 voluntarios con una hoja compartida.", aplicacion: "Redujo los huecos de cobertura del sábado.", limites: "Reconoce que le falta formación en gestión de conflictos." }, criterios: { validez: 2, suficiencia: 2 }, falta: "Adjuntar la planilla de turnos y la confirmación de la coordinadora.", artefactos: [], verificacion: { nombre: "Coordinadora del banco", rol: "Responsable de voluntariado", contacto: "", estado: "solicitada" }, dialogue: [] } },
      ],
      // Demo only: one clearly fictitious subject so the flows can be explored. In production the catalog
      // holds only real subjects added by the coordination from their official teaching guides.
      catalogo_asignaturas: [
        { id: CAT1, universidad: "Universidad de ejemplo (ficticia)", titulacion: "Grado de ejemplo — NO OFICIAL", codigo_ruct: "", nivel: "Grado", asignatura: "Gestión de equipos (EJEMPLO DE DEMO)", codigo_asignatura: "", curso_academico: "2025-26", ects: 6, caracter: "Obligatoria",
          resultados: [{ id: "RA1", texto: "Planifica y coordina el trabajo de un equipo para alcanzar objetivos compartidos." }, { id: "RA2", texto: "Gestiona conflictos y facilita la toma de decisiones en grupo." }, { id: "RA3", texto: "Comunica de forma clara la información del proyecto a las partes interesadas." }, { id: "RA4", texto: "Evalúa el desempeño del equipo y propone mejoras." }],
          fuente_url: "https://example.org/demo-no-oficial", estado: "publicada", created_at: "2026-10-01T09:00:00Z" },
      ],
      acreditaciones: [{ id: "a0000000-0000-4000-8000-000000000002", user_id: OTHER, asignatura_id: CAT1, estado: "activa", conversacion: {}, recursos: {}, created_at: "2026-10-02T09:00:00Z" }],
      solicitudes_catalogo: [],
    };
  }
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { db = seed(); }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  const blobs = new Map();

  /* ---------- Query builder (the subset app.js uses) ---------- */
  class Query {
    constructor(table) { this.t = table; this.filters = []; this.op = "select"; this.one = null; }
    select() { return this; }
    eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
    neq(k, v) { this.filters.push((r) => r[k] !== v); return this; }
    in(k, v) { this.filters.push((r) => v.includes(r[k])); return this; }
    order(k) { this.sort = k; return this; }
    maybeSingle() { this.one = "maybe"; return this; }
    single() { this.one = "single"; return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    upsert(row) { this.op = "upsert"; this.payload = row; return this; }
    delete() { this.op = "delete"; return this; }
    rows() { return db[this.t].filter((r) => this.filters.every((f) => f(r))); }
    run() {
      const uid = db.session?.user?.id;
      if (this.op === "select") {
        let rows = this.rows();
        if (this.t === "catalogo_asignaturas" && db.perfiles.find((p) => p.user_id === uid)?.role !== "coordinador") rows = rows.filter((r) => r.estado === "publicada");
        if (this.t === "acreditaciones" || this.t === "evidencias") rows = rows.filter((r) => r.user_id === uid || db.perfiles.find((p) => p.user_id === uid)?.role === "coordinador");
        if (this.t === "perfiles") rows = rows.filter((r) => r.user_id === uid || (r.compartir_con_coordinacion && db.perfiles.find((p) => p.user_id === uid)?.role === "coordinador"));
        if (this.sort) rows = [...rows].sort((a, b) => String(a[this.sort] || "").localeCompare(String(b[this.sort] || "")));
        rows = structuredClone(rows);
        if (this.one) return { data: rows[0] ?? null, error: rows[0] || this.one === "maybe" ? null : { message: "not found" } };
        return { data: rows, error: null };
      }
      if (this.op === "insert") {
        if (db[this.t].some((r) => r.user_id === this.payload.user_id && this.t === "perfiles")) return { error: { code: "23505" } };
        const base = this.t === "perfiles" ? { role: "participante", consentimiento_at: null, compartir_con_coordinacion: false, objetivo: {} } : { id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()), user_id: uid, estado: this.t === "solicitudes_catalogo" ? "pendiente" : this.t === "acreditaciones" ? "activa" : undefined, created_at: new Date().toISOString(), ...(this.t === "acreditaciones" ? { conversacion: {}, recursos: {} } : {}) };
        const row = { ...base, ...structuredClone(this.payload) };
        db[this.t].push(row);
        if (this.one) { persist(); return { data: structuredClone(row), error: null }; }
      }
      if (this.op === "update") this.rows().forEach((r) => Object.assign(r, structuredClone(this.payload)));
      if (this.op === "upsert") {
        const p = structuredClone(this.payload), i = db[this.t].findIndex((r) => r.id === p.id);
        if (i >= 0) Object.assign(db[this.t][i], p); else db[this.t].push({ user_id: uid, created_at: new Date().toISOString(), ...p });
      }
      if (this.op === "delete") { const kill = new Set(this.rows()); db[this.t] = db[this.t].filter((r) => !kill.has(r)); }
      persist();
      return { data: null, error: null };
    }
    then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  }

  let listeners = [];
  const emit = (ev) => listeners.forEach((fn) => fn(ev, db.session));
  window.supabase = {
    createClient() {
      return {
        auth: {
          getSession: async () => ({ data: { session: db.session } }),
          onAuthStateChange(fn) { listeners.push(fn); return { data: { subscription: { unsubscribe() {} } } }; },
          async signInWithOtp({ email }) {
            // Demo: the "email link" opens itself after a moment.
            setTimeout(() => {
              db.session = { access_token: "demo", user: { id: ME, email } };
              persist(); emit("SIGNED_IN");
            }, 2200);
            return { error: null };
          },
          async signOut() { db.session = null; persist(); emit("SIGNED_OUT"); return { error: null }; },
        },
        from: (t) => new Query(t),
        storage: {
          from: () => ({
            async upload(path, file) { blobs.set(path, file); return { data: { path }, error: null }; },
            async remove(paths) { paths.forEach((p) => blobs.delete(p)); return { error: null }; },
            async createSignedUrl(path) { return blobs.has(path) ? { data: { signedUrl: URL.createObjectURL(blobs.get(path)) }, error: null } : { data: null, error: {} }; },
          }),
        },
      };
    },
  };

  /* ---------- /api routes, answered by Claude through claude.ai ---------- */
  const SYSTEM = (obj) => {
    const nombre = obj?.generico ? "competencias transversales (genérico)" : [obj?.asignatura, obj?.titulacion, obj?.universidad].filter(Boolean).join(" · ");
    const ras = (obj?.resultados || []).map((r) => `${r.id}: ${r.texto}`).join("\n");
    return `Eres Lumen, un agente que ayuda a una persona a convertir lo que aprende en su día a día (trabajo, voluntariado, formación no reglada, vida diaria) en evidencias que una universidad pueda valorar para reconocerle créditos.

Objetivo de acreditación: ${nombre}.
Resultados de aprendizaje del objetivo:
${ras}

Las evidencias deben ser válidas, auténticas, suficientes y vigentes. A lo largo de la entrevista consigue, sin convertirla en un interrogatorio: 1) qué aprendió y cómo lo explica; 2) un caso concreto en el que lo aplicó y qué resultado obtuvo; 3) el contexto, una fecha aproximada y cuántas horas le dedicó; 4) qué producto verificable generó que pueda adjuntar; 5) quién podría confirmarlo (nombre y rol); 6) qué límites tiene su dominio.
Orienta las preguntas hacia los resultados de aprendizaje con los que encaja lo que cuenta.
Estilo: español; tono cálido y exigente; como mucho una frase que recoja algo concreto de lo que dijo y después UNA sola pregunta abierta; sin listas ni markdown; máximo 70 palabras. No prometas créditos.`;
  };
  const acObj = (id) => { const ac = db.acreditaciones.find((a) => a.id === id && a.user_id === db.session?.user?.id); return ac && db.catalogo_asignaturas.find((c) => c.id === ac.asignatura_id); };
  const myObj = (acId) => { const a = acObj(acId); return a ? { ...a, generico: false } : { generico: true, resultados: [{ id: "C1", texto: "Analiza críticamente información y argumentos, identificando evidencias, sesgos y límites." }, { id: "C2", texto: "Utiliza tecnologías digitales y datos de forma reflexiva, eficaz y ética." }, { id: "C3", texto: "Comunica ideas complejas con claridad, de forma oral y escrita, a públicos diversos." }, { id: "C4", texto: "Participa en contextos sociales y ciudadanos con criterio y responsabilidad." }, { id: "C5", texto: "Planifica y gestiona proyectos, y coordina o lidera equipos." }] }; };
  const fail = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
  const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    const path = typeof url === "string" ? url : url.url;
    if (path === "/api/config") return json({ supabaseUrl: "demo", supabaseAnonKey: "demo" });
    if (path === "/api/account") { const uid = db.session?.user?.id; db.perfiles = db.perfiles.filter((p) => p.user_id !== uid); db.evidencias = db.evidencias.filter((e) => e.user_id !== uid); db.acreditaciones = db.acreditaciones.filter((e) => e.user_id !== uid); persist(); return new Response(null, { status: 204 }); }
    if (!path.startsWith("/api/")) return realFetch(url, init);
    if (path === "/api/fuente") return fail(501, "En la demo no se pueden abrir enlaces; en la versión real sí.");
    if (path === "/api/investigar") return json({ nada: true });
    const sample = await use("sample");
    if (!sample) return fail(503, "La IA no está disponible en esta vista de la demo.");
    const body = JSON.parse(init.body || "{}"), obj = myObj(body.acreditacion_id), ids = obj.resultados.map((r) => r.id);
    try {
      if (path === "/api/chat") {
        const msgs = body.history.map((m) => ({ ...m }));
        msgs[0] = { role: "user", content: `${SYSTEM(obj)}\n\nLo que quiero documentar: «${body.titulo}».\n\n${msgs[0].content}` };
        if (body.closing) msgs[msgs.length - 1].content += "\n\n[Instrucción: cierra la entrevista. Pide que formule en dos o tres frases lo que ahora sabe hacer, la prueba que mejor lo demuestra y lo que aún le falta. Si prefiere seguir, que escriba «seguir».]";
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(ctrl) {
            let sent = 0;
            try {
              const r = await sample(msgs, { cache: false, onText: ({ text }) => { ctrl.enqueue(enc.encode(text.slice(sent))); sent = text.length; } });
              if (r.text.length > sent) ctrl.enqueue(enc.encode(r.text.slice(sent)));
              ctrl.close();
            } catch (e) { ctrl.error(e); }
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/plain" } });
      }
      if (body.kind === "interview") {
        const transcript = body.history.map((m) => (m.role === "user" ? "Persona" : "Lumen") + ": " + m.content).join("\n");
        const o = await sample.json(`Analiza esta entrevista para un expediente de reconocimiento académico de aprendizajes por experiencia. Usa solo lo que dijo la persona; no inventes.
Resultados disponibles:
${obj.resultados.map((r) => r.id + ": " + r.texto).join("\n")}
Responde con solo un objeto JSON: {"titulo":"máx. 8 palabras","evidencias":{"idea":"","aplicacion":"","argumentacion":"","conexion":"","limites":""},"resultados":["ID"],"validez":0,"suficiencia":0,"contexto":"Trabajo|Voluntariado|Formación no reglada|Vida diaria / autodidacta|","horas":0,"fecha":"AAAA-MM-DD o vacío","verificador_nombre":"","verificador_rol":"","falta":"una frase"}
Evidencias: 1-2 frases en tercera persona por apartado, "" si no hay. resultados: 0 a 3 IDs. validez y suficiencia de 0 a 3. Hoy es ${new Date().toISOString().slice(0, 10)}.

Entrevista sobre «${body.titulo}»:
${transcript.slice(-14000)}`);
        return json({ ...o, resultados: (o.resultados || []).filter((x) => ids.includes(x)).slice(0, 3) });
      }
      if (body.kind === "diary") {
        const o = await sample.json(`Vincula esta entrada de diario de aprendizaje con resultados de aprendizaje universitarios. Usa solo lo escrito.
Resultados:
${obj.resultados.map((r) => r.id + ": " + r.texto).join("\n")}
Entrada (${body.contexto}, ${body.horas} h): «${body.texto}»
Responde con solo JSON: {"titulo":"máx. 8 palabras","resultados":["ID"],"validez":0,"suficiencia":0,"falta":"una frase"}`, { modelTier: "quick" });
        return json({ ...o, resultados: (o.resultados || []).filter((x) => ids.includes(x)).slice(0, 3) });
      }
      if (body.kind === "vincular") {
        const vinculos = {};
        for (const ac of db.acreditaciones.filter((a) => a.user_id === db.session?.user?.id && !(body.excluir || []).includes(a.id))) {
          const a = acObj(ac.id); if (!a) continue;
          const o = await sample.json(`¿Qué resultados de aprendizaje de la asignatura «${a.asignatura}» respalda esta evidencia? Sé exigente: solo los que de verdad respalda.\nResultados:\n${a.resultados.map((r) => r.id + ": " + r.texto).join("\n")}\nEvidencia: «${String(body.texto).slice(0, 3000)}»\nResponde con solo JSON: {"resultados":["ID"]}`, { modelTier: "quick" });
          const ok = (o?.resultados || []).filter((x) => a.resultados.some((r) => r.id === x));
          if (ok.length) vinculos[ac.id] = ok;
        }
        return json({ vinculos });
      }
      if (body.kind === "relink") {
        const a = acObj(body.acreditacion_id); if (!a) return fail(404, "No encuentro esa acreditación.");
        const evs = db.evidencias.filter((e) => e.user_id === db.session?.user?.id).map((e) => e.data);
        if (!evs.length) return json({ cobertura: [] });
        const o = await sample.json(`Relaciona estas evidencias con los resultados de aprendizaje de la asignatura «${a.asignatura}». Sé exigente.\nResultados:\n${a.resultados.map((r) => r.id + ": " + r.texto).join("\n")}\nEvidencias:\n${evs.slice(-40).map((e) => `- id ${e.id} · «${e.titulo}» · ${Object.values(e.evidencias || {}).join(" ").slice(0, 500)}`).join("\n")}\nResponde con solo JSON: {"cobertura":[{"resultado_id":"RA1","evidencias":["id"]}]}`);
        const ids2 = evs.map((e) => e.id);
        return json({ cobertura: (o?.cobertura || []).filter((c) => a.resultados.some((r) => r.id === c.resultado_id)).map((c) => ({ resultado_id: c.resultado_id, evidencias: (c.evidencias || []).filter((x) => ids2.includes(x)) })) });
      }
      if (body.kind === "propose") {
        const me = db.perfiles.find((x) => x.user_id === db.session?.user?.id);
        const evs = db.evidencias.filter((e) => e.user_id === me.user_id).map((e) => e.data);
        const cat = db.catalogo_asignaturas.filter((x) => x.estado === "publicada");
        const intencion = String(body.intencion || "").trim().slice(0, 1000);
        if (!intencion && evs.length < 2) return fail(400, "Documenta al menos dos aprendizajes para que Lumen pueda proponerte acreditaciones.");
        if (!cat.length) return fail(409, "Todavía no hay asignaturas en el catálogo oficial de Lumen.");
        const evIds = evs.map((e) => e.id);
        const o = await sample.json(`Eres el orientador de acreditación de Lumen. Relaciona los aprendizajes de esta persona con asignaturas del CATÁLOGO de abajo. No propongas nada que no esté en él ni cambies sus resultados de aprendizaje.
${intencion ? `Lo que quiere acreditar: «${intencion}»` : "No ha dicho qué quiere acreditar: elige las de mejor encaje."}

Catálogo:
${cat.map((a) => `- asignatura ${a.id} · «${a.asignatura}» · ${a.titulacion} · ${a.universidad} · ${a.ects} ECTS\n${a.resultados.map((r) => `    ${r.id}: ${r.texto}`).join("\n")}`).join("\n")}

Evidencias:
${evs.slice(-40).map((e) => `- id ${e.id} · «${e.titulo}» · ${e.contexto || "sin contexto"} · ${e.horas || 0} h\n  ${Object.values(e.evidencias || {}).join(" ").slice(0, 600)}`).join("\n") || "(todavía ninguna)"}

Responde con solo JSON: {"propuestas":[{"asignatura_id":"","cobertura":[{"resultado_id":"RA1","evidencias":["id"]}],"encaje":0,"motivo":"","siguientes_pasos":[""]}],"sin_coincidencia":""}
De 0 a 3 propuestas, solo con asignatura_id del catálogo.${intencion ? " Si nada del catálogo encaja con lo que pide, devuelve una lista vacía y explícalo en sin_coincidencia." : ""} cobertura: ids oficiales de resultados y solo ids de evidencias de la lista. encaje 0-100. motivo: dos frases citando evidencias por su título. siguientes_pasos: 2-4 acciones concretas.`);
        const byId = new Map(cat.map((a) => [a.id, a]));
        const origen = intencion ? "usuario" : "lumen";
        const list = (Array.isArray(o?.propuestas) ? o.propuestas : []).filter((p) => byId.has(p.asignatura_id)).slice(0, 3).map((p) => {
          const a = byId.get(p.asignatura_id), ras = new Set(a.resultados.map((r) => r.id));
          return { asignatura_id: a.id, asignatura: a.asignatura, titulacion: a.titulacion, universidad: a.universidad, ects: Number(a.ects), nivel: a.nivel, resultados: a.resultados, fuente_url: a.fuente_url,
            cobertura: (p.cobertura || []).filter((c) => ras.has(c.resultado_id)).map((c) => ({ resultado_id: c.resultado_id, evidencias: (c.evidencias || []).filter((id) => evIds.includes(id)) })),
            encaje: Math.max(0, Math.min(100, Math.round(Number(p.encaje) || 0))), motivo: p.motivo || "", siguientes_pasos: (p.siguientes_pasos || []).slice(0, 4),
            id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()), creada: new Date().toISOString(), origen, intencion, estado: "nueva" };
        });
        me.propuestas = [...list, ...(me.propuestas || []).filter((p) => p.asignatura_id && (p.estado === "adoptada" || (p.estado === "nueva" && p.origen !== origen)))].slice(0, 8);
        me.propuestas_n_evidencias = evs.length;
        persist();
        return json({ propuestas: me.propuestas, sin_coincidencia: String(o?.sin_coincidencia || "") });
      }
      if (path === "/api/catalogo") {
        if (!body.texto) return fail(400, "En la demo no se pueden abrir enlaces: despliega «pegar el texto de la guía» y pega su contenido.");
        const o = await sample.json(`Este texto debería ser la guía docente oficial de una asignatura universitaria. Extrae sus datos COPIÁNDOLOS LITERALMENTE, sin inventar nada. Responde con solo JSON: {"es_guia_docente":true,"universidad":"","titulacion":"","nivel":"Grado|Máster|Microcredencial|Título propio","asignatura":"","codigo_asignatura":"","curso_academico":"","ects":0,"caracter":"","resultados":["resultado de aprendizaje literal"],"aviso":""}\n\n${String(body.texto).slice(0, 60000)}`);
        if (o?.es_guia_docente === false) return fail(422, "Ese texto no parece la guía docente de una asignatura.");
        return json({ ...o, resultados: (o.resultados || []).filter((t) => typeof t === "string" && t.trim()), fuente_url: body.url });
      }
      if (body.kind === "extract") {
        const arr = await sample.json(`Extrae de esta guía docente los resultados de aprendizaje (o, si no hay, las competencias específicas) tal como están redactados, sin códigos. Máximo 12. Responde con solo un array JSON de strings.\n\n${String(body.guia).slice(0, 20000)}`);
        return json({ resultados: (Array.isArray(arr) ? arr : []).filter((s) => typeof s === "string" && s.trim()) });
      }
      return fail(400, "Tipo de análisis desconocido.");
    } catch (e) {
      return fail(e?.code === "rate_limited" ? 429 : e?.code === "not_granted" ? 403 : 502, e?.code === "not_granted" ? "Para usar la IA en la demo, permite el acceso a Claude cuando la página lo pida." : "La IA no respondió. Inténtalo de nuevo.");
    }
  };
  window.__lumenDemoReset = () => { try { localStorage.removeItem(KEY); } catch {} location.reload(); };
})();
