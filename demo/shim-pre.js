// Demo backend for claude.ai: an in-browser stand-in for Supabase and the /api routes.
// The production app.js runs unchanged on top of it.
(function () {
  const KEY = "lumen_demo_v1";
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
        { id: "e0000000-0000-4000-8000-000000000001", user_id: OTHER, created_at: "2026-10-05T18:00:00Z", data: { id: "e0000000-0000-4000-8000-000000000001", kind: "evidence", tipo: "entrevista", titulo: "Coordinación de un banco de alimentos (ejemplo)", fecha: "2026-09-20", createdAt: 1, contexto: "Voluntariado", horas: 20, resultados: ["C5", "C3"], evidencias: { idea: "Explica cómo organizó turnos de 15 voluntarios con una hoja compartida.", aplicacion: "Redujo los huecos de cobertura del sábado.", limites: "Reconoce que le falta formación en gestión de conflictos." }, criterios: { validez: 2, suficiencia: 2 }, falta: "Adjuntar la planilla de turnos y la confirmación de la coordinadora.", artefactos: [], verificacion: { nombre: "Coordinadora del banco", rol: "Responsable de voluntariado", contacto: "", estado: "solicitada" }, dialogue: [] } },
      ],
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
        if (this.t === "perfiles") rows = rows.filter((r) => r.user_id === uid || (r.compartir_con_coordinacion && db.perfiles.find((p) => p.user_id === uid)?.role === "coordinador"));
        if (this.sort) rows = [...rows].sort((a, b) => String(a[this.sort] || "").localeCompare(String(b[this.sort] || "")));
        rows = structuredClone(rows);
        if (this.one) return { data: rows[0] ?? null, error: rows[0] || this.one === "maybe" ? null : { message: "not found" } };
        return { data: rows, error: null };
      }
      if (this.op === "insert") {
        if (db[this.t].some((r) => r.user_id === this.payload.user_id && this.t === "perfiles")) return { error: { code: "23505" } };
        db[this.t].push({ role: "participante", consentimiento_at: null, compartir_con_coordinacion: false, objetivo: {}, ...structuredClone(this.payload) });
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
  const myObj = () => { const p = db.perfiles.find((x) => x.user_id === db.session?.user?.id); return p?.objetivo?.resultados?.length ? p.objetivo : { generico: true, resultados: [{ id: "C1", texto: "Analiza críticamente información y argumentos, identificando evidencias, sesgos y límites." }, { id: "C2", texto: "Utiliza tecnologías digitales y datos de forma reflexiva, eficaz y ética." }, { id: "C3", texto: "Comunica ideas complejas con claridad, de forma oral y escrita, a públicos diversos." }, { id: "C4", texto: "Participa en contextos sociales y ciudadanos con criterio y responsabilidad." }, { id: "C5", texto: "Planifica y gestiona proyectos, y coordina o lidera equipos." }] }; };
  const fail = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
  const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    const path = typeof url === "string" ? url : url.url;
    if (path === "/api/config") return json({ supabaseUrl: "demo", supabaseAnonKey: "demo" });
    if (path === "/api/account") { const uid = db.session?.user?.id; db.perfiles = db.perfiles.filter((p) => p.user_id !== uid); db.evidencias = db.evidencias.filter((e) => e.user_id !== uid); persist(); return new Response(null, { status: 204 }); }
    if (!path.startsWith("/api/")) return realFetch(url, init);
    const sample = await use("sample");
    if (!sample) return fail(503, "La IA no está disponible en esta vista de la demo.");
    const body = JSON.parse(init.body || "{}"), obj = myObj(), ids = obj.resultados.map((r) => r.id);
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
      if (body.kind === "propose") {
        const me = db.perfiles.find((x) => x.user_id === db.session?.user?.id);
        const evs = db.evidencias.filter((e) => e.user_id === me.user_id).map((e) => e.data);
        const intencion = String(body.intencion || "").trim().slice(0, 1000);
        if (!intencion && evs.length < 2) return fail(400, "Documenta al menos dos aprendizajes para que Lumen pueda proponerte acreditaciones.");
        const evIds = evs.map((e) => e.id);
        const resumen = evs.slice(-40).map((e) => `- id ${e.id} · «${e.titulo}» · ${e.contexto || "sin contexto"} · ${e.horas || 0} h · ${e.fecha}\n  ${Object.values(e.evidencias || {}).join(" ").slice(0, 600)}`).join("\n");
        const o = await sample.json(`Eres el orientador de acreditación de Lumen. Propón objetivos de reconocimiento académico (sistema universitario español) que encajen con los aprendizajes documentados${intencion ? " y con lo que la persona quiere acreditar" : ""}.
${intencion ? `Lo que quiere acreditar: «${intencion}»` : "No ha dicho qué quiere acreditar: propón tú las opciones con mejor encaje."}

Evidencias:
${resumen || "(todavía ninguna)"}

Responde con solo un objeto JSON: {"propuestas":[{"titulo":"","tipo":"Asignatura de grado|Asignatura de máster|Microcredencial|Competencia transversal","titulacion":"","asignatura":"","ects":6,"resultados":[{"id":"RA1","texto":""}],"cobertura":[{"resultado_id":"RA1","evidencias":["id de evidencia"]}],"encaje":0,"motivo":"","siguientes_pasos":[""]}]}
De 1 a 3 propuestas, de mayor a menor encaje.${intencion ? " La primera responde a lo que pide, aunque el encaje sea bajo." : ""} Titulación y asignatura plausibles y genéricas, sin afirmar que existan tal cual en una universidad concreta. De 4 a 6 resultados de aprendizaje como en una guía docente. cobertura: solo ids de la lista de evidencias que respalden de verdad cada resultado. encaje 0-100. motivo: dos frases citando evidencias por su título. siguientes_pasos: 2-4 acciones concretas.`);
        const list = (Array.isArray(o?.propuestas) ? o.propuestas : []).slice(0, 3).map((p) => {
          const ras = (p.resultados || []).slice(0, 8).map((r, i) => ({ id: "RA" + (i + 1), texto: String(r.texto || "").trim(), _o: r.id }));
          const map = new Map(ras.map((r) => [r._o, r.id]));
          return { titulo: p.titulo || "", tipo: p.tipo || "Asignatura de grado", titulacion: p.titulacion || "", asignatura: p.asignatura || p.titulo || "", ects: Number(p.ects) || 0,
            resultados: ras.map(({ id, texto }) => ({ id, texto })),
            cobertura: (p.cobertura || []).filter((c) => map.has(c.resultado_id)).map((c) => ({ resultado_id: map.get(c.resultado_id), evidencias: (c.evidencias || []).filter((id) => evIds.includes(id)) })),
            encaje: Math.max(0, Math.min(100, Math.round(Number(p.encaje) || 0))), motivo: p.motivo || "", siguientes_pasos: (p.siguientes_pasos || []).slice(0, 4),
            id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()), creada: new Date().toISOString(), origen: intencion ? "usuario" : "lumen", intencion, estado: "nueva" };
        });
        const origen = intencion ? "usuario" : "lumen";
        me.propuestas = [...list, ...(me.propuestas || []).filter((p) => p.estado === "adoptada" || (p.estado === "nueva" && p.origen !== origen))].slice(0, 8);
        me.propuestas_n_evidencias = evs.length;
        persist();
        return json({ propuestas: me.propuestas });
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
