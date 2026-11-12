"use strict";
const $ = (id) => document.getElementById(id);
const MAX_TURNS = 7, HOURS_PER_ECTS_MIN = 25, HOURS_PER_ECTS_MAX = 30, VIGENCIA_YEARS = 5;
const CONSENT_VERSION = "piloto-v1";
const BUCKET = "artefactos";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Before choosing an official subject there are no learning outcomes to link evidence to. */
const NO_OBJ = { universidad: "", titulacion: "", asignatura: "", ects: "", resultados: [], sinObjetivo: true };
const EV_LABELS = { idea: "Qué aprendió", aplicacion: "Aplicación", argumentacion: "Argumentación", conexion: "Conexión con su experiencia", limites: "Límites y dudas", sintesis: "Síntesis final", texto: "Registro del diario", fidelidad: "Fidelidad al contenido", logros: "Logros", competencias: "Lo que demuestra", contenidos: "Contenidos que acredita el documento oficial" };
const CRIT = [["validez", "Validez"], ["autenticidad", "Autenticidad"], ["suficiencia", "Suficiencia"], ["vigencia", "Vigencia"]];
const CONTEXTOS = ["Trabajo", "Voluntariado", "Formación no reglada", "Vida diaria / autodidacta"];

const safe = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const normalize = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => { try { return new Date(d + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" }); } catch { return d; } };
const num = (v) => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? n : 0; };
const clamp03 = (v) => Math.max(0, Math.min(3, Math.round(Number(v) || 0)));
const fmtN = (n) => (Math.round(n * 10) / 10).toLocaleString("es-ES");
const byDate = (a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0);

/* ================= Session and data ================= */
let googleCfg = null, publicCfg = null;
let sb = null, session = null, perfil = null, objetivo = NO_OBJ, evidences = [], catalogo = [];
/** The accreditation tree: one row per subject the person works towards, each with its own conversation and resources. */
let acreditaciones = [], acActual = null, faltaTabla = false, vista = "agente";

function showScreen(name) {
  for (const [id, n] of [["sLoading", "loading"], ["sLogin", "login"], ["sSent", "sent"], ["sConsent", "consent"], ["sApp", "app"]]) $(id).hidden = n !== name;
}

async function boot() {
  try {
    const cfg = await fetch("/api/config").then((r) => { if (!r.ok) throw new Error(); return r.json(); });
    googleCfg = cfg.google || null; publicCfg = cfg;
    sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "implicit" } });
  } catch {
    $("loadingMsg").textContent = "Lumen no está disponible en este momento. Inténtalo de nuevo en unos minutos.";
    return;
  }
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((event, s) => {
    const changed = (s?.user?.id || null) !== (session?.user?.id || null);
    session = s;
    if (changed) route();
  });
  route();
}

let routing = 0;
async function route() {
  const token = ++routing;
  if (!session) { showScreen("login"); return; }
  showScreen("loading");
  try {
    await loadPerfil();
    if (token !== routing) return;
    if (!perfil.consentimiento_at) {
      $("cName").value = perfil.nombre || "";
      showScreen("consent");
      return;
    }
    await Promise.all([loadEvidences(), loadCatalog(), loadAcreditaciones()]);
    await migrarLegado();
    if (token !== routing) return;
    enterApp();
  } catch (e) {
    console.error(e);
    $("loadingMsg").textContent = "No se pudieron cargar tus datos. Recarga la página para intentarlo de nuevo.";
  }
}

async function loadPerfil() {
  const me = session.user.id;
  let { data, error } = await sb.from("perfiles").select("*").eq("user_id", me).maybeSingle();
  if (error) throw error;
  if (!data) {
    const ins = await sb.from("perfiles").insert({ user_id: me, nombre: "" });
    if (ins.error && ins.error.code !== "23505") throw ins.error;
    ({ data, error } = await sb.from("perfiles").select("*").eq("user_id", me).single());
    if (error) throw error;
  }
  perfil = data;
}
/** Published subjects (coordinators also see drafts and withdrawn ones). */
async function loadCatalog() {
  const { data, error } = await sb.from("catalogo_asignaturas").select("*").order("universidad").order("asignatura");
  if (error) throw error;
  catalogo = data;
}
/** The participant's target always takes its outcomes from the official catalog, never from what the profile stores. */
function objFromSubject(a) {
  return { asignatura_id: a.id, universidad: a.universidad, titulacion: a.titulacion, codigo_ruct: a.codigo_ruct, nivel: a.nivel, asignatura: a.asignatura, codigo_asignatura: a.codigo_asignatura, curso_academico: a.curso_academico, ects: Number(a.ects), caracter: a.caracter, resultados: a.resultados, fuente_url: a.fuente_url, estado: a.estado };
}
function resolveObjetivo(stored) {
  const a = stored?.asignatura_id && catalogo.find((x) => x.id === stored.asignatura_id);
  if (a) return objFromSubject(a);
  if (stored?.asignatura_id && stored.resultados?.length) return { ...stored, estado: "retirada" };
  return NO_OBJ;
}
async function loadAcreditaciones() {
  const { data, error } = await sb.from("acreditaciones").select("*").eq("user_id", session.user.id).order("created_at");
  if (error) { console.error(error); faltaTabla = true; acreditaciones = []; return; }
  faltaTabla = false; acreditaciones = data;
}
const acDe = (id) => acreditaciones.find((a) => a.id === id);
/** The official subject behind an accreditation (read from the catalog, so its outcomes are always the official ones). */
function subjectOf(ac) {
  const a = ac && catalogo.find((x) => x.id === ac.asignatura_id);
  return a ? objFromSubject(a) : { ...NO_OBJ, sinObjetivo: false, asignatura: "Asignatura retirada del catálogo", asignatura_id: ac?.asignatura_id, estado: "retirada" };
}
/** Evidences that count for one accreditation, each seen with that accreditation's linked outcomes. */
const evsDe = (acId, lista = evidences) => lista.filter((e) => e.vinculos?.[acId]?.length || e.acreditacion_origen === acId).map((e) => ({ ...e, resultados: e.vinculos?.[acId] || [] }));
/** Before the tree, a profile had a single target: it becomes the first accreditation, keeping its links and resources. */
async function migrarLegado() {
  const id = perfil.objetivo?.asignatura_id;
  if (faltaTabla || !id || acreditaciones.some((a) => a.asignatura_id === id) || !catalogo.some((x) => x.id === id)) return;
  const recursos = perfil.recursos?.asignatura_id === id ? { generado: perfil.recursos.generado, items: perfil.recursos.items || [] } : {};
  const { data, error } = await sb.from("acreditaciones").insert({ asignatura_id: id, recursos }).select().single();
  if (error) { console.error(error); return; }
  acreditaciones.push(data);
  for (const e of evidences) {
    if (!e.resultados?.length || e.vinculos) continue;
    e.vinculos = { [data.id]: e.resultados };
    await sb.from("evidencias").upsert({ id: e.id, data: e });
  }
  await updatePerfil({ objetivo: {} }).catch(() => {});
}
async function createAcreditacion(a, cobertura) {
  let ac = acreditaciones.find((x) => x.asignatura_id === a.id);
  if (!ac) {
    const { data, error } = await sb.from("acreditaciones").insert({ asignatura_id: a.id }).select().single();
    if (error) throw new Error(faltaTabla ? "Falta un paso de instalación en la base de datos (007_acreditaciones.sql). Avisa a la coordinación." : "No se pudo añadir la acreditación. Inténtalo de nuevo.");
    ac = data; acreditaciones.push(ac);
  }
  if (cobertura?.length) await aplicarCobertura(ac.id, cobertura);
  else await relinkAc(ac.id).catch((e) => aiProblem(e));
  return ac;
}
async function updateAc(ac, patch) {
  Object.assign(ac, patch);
  const { error } = await sb.from("acreditaciones").update(patch).eq("id", ac.id);
  if (error) throw new Error("No se pudo guardar.");
}
async function removeAc(ac) {
  const { error } = await sb.from("acreditaciones").delete().eq("id", ac.id);
  if (error) throw new Error("No se pudo quitar.");
  acreditaciones = acreditaciones.filter((x) => x.id !== ac.id);
  delete chats[ac.id];
}
/** Adds links from a coverage map ({resultado_id, evidencias}) without removing the ones the person set by hand. */
async function aplicarCobertura(acId, cobertura) {
  const byEv = new Map();
  for (const c of cobertura || []) for (const ev of c.evidencias) byEv.set(ev, [...(byEv.get(ev) || []), c.resultado_id]);
  let n = 0;
  for (const e of evidences) {
    const add = byEv.get(e.id); if (!add?.length) continue;
    const prev = e.vinculos?.[acId] || [], next = [...new Set([...prev, ...add])];
    if (next.length === prev.length) continue;
    await saveEvidence({ ...structuredClone(e), vinculos: { ...(e.vinculos || {}), [acId]: next } });
    n++;
  }
  return n;
}
/** Asks Lumen which of all the person's evidences back this accreditation's outcomes. */
async function relinkAc(acId) {
  if (!aiOk || !evidences.length) return 0;
  const { cobertura } = await (await api("/api/analyze", { kind: "relink", acreditacion_id: acId })).json();
  return aplicarCobertura(acId, cobertura);
}
/** Links a new evidence to the outcomes of every other accreditation in the tree (in the background). */
async function vincularEnArbol(e, excluir = []) {
  if (!aiOk || !acreditaciones.some((a) => !excluir.includes(a.id))) return;
  try {
    const texto = [e.titulo, ...Object.values(e.evidencias || {})].join(". ");
    const { vinculos } = await (await api("/api/analyze", { kind: "vincular", texto, contexto: e.contexto, horas: e.horas, excluir })).json();
    if (!Object.keys(vinculos || {}).length) return;
    const cur = evidences.find((x) => x.id === e.id); if (!cur) return;
    const v = { ...(cur.vinculos || {}) };
    for (const [k, ids] of Object.entries(vinculos)) v[k] = [...new Set([...(v[k] || []), ...ids])];
    await saveEvidence({ ...structuredClone(cur), vinculos: v });
  } catch (err) { aiProblem(err); }
}
async function loadEvidences() {
  const { data, error } = await sb.from("evidencias").select("id,data,created_at").eq("user_id", session.user.id).order("created_at");
  if (error) throw error;
  evidences = data.map((r) => r.data);
}
async function updatePerfil(patch) {
  const { error } = await sb.from("perfiles").update(patch).eq("user_id", session.user.id);
  if (error) throw error;
  Object.assign(perfil, patch);
}
async function saveEvidence(e) {
  const i = evidences.findIndex((x) => x.id === e.id);
  if (i >= 0) evidences[i] = e; else evidences.push(e);
  render();
  const { error } = await sb.from("evidencias").upsert({ id: e.id, data: e });
  if (error) { console.error(error); throw new Error("No se pudo guardar. Revisa tu conexión e inténtalo de nuevo."); }
}
async function deleteEvidence(e) {
  const paths = (e.artefactos || []).filter((a) => a.origen !== "cv").map((a) => a.path).filter(Boolean); // the CV is shared by many evidences
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  const { error } = await sb.from("evidencias").delete().eq("id", e.id);
  if (error) throw new Error("No se pudo eliminar.");
  evidences = evidences.filter((x) => x.id !== e.id);
  render();
}
async function uploadFile(file, evidenceId, folder = "") {
  if (file.size > MAX_FILE_BYTES) throw new Error("El archivo supera los 25 MB.");
  const clean = file.name.normalize("NFD").replace(/[^\w.-]+/g, "_").slice(-80);
  const path = `${session.user.id}/${folder ? folder + "/" : ""}${evidenceId}/${Date.now()}-${clean}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error("No se pudo subir el archivo.");
  return { name: file.name, path, size: file.size, subidoEl: new Date().toISOString() };
}
async function openFile(path) {
  const w = window.open("", "_blank");
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { w?.close(); alert("No se pudo abrir el archivo."); return; }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}

/* ================= AI calls ================= */
let aiOk = true;
async function api(path, body) {
  const { data } = await sb.auth.getSession();
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + (data.session?.access_token || "") }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = "La IA no está disponible ahora mismo.";
    try { msg = (await r.json()).error || msg; } catch {}
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return r;
}
/** Makes a failed AI call visible: the pill turns red and the help line says why. */
function aiProblem(e) {
  if (e?.status === 429 || e?.status === 403) { aiState(false, e.message); return; }
  if (!e?.status) return;
  $("aiStatus").textContent = "IA con problemas"; $("aiStatus").classList.remove("live");
  $("helpLine").textContent = `La IA no ha respondido: ${e.message} Mientras tanto, Lumen usa preguntas automáticas.`;
}
function aiState(ok, msg) {
  aiOk = ok;
  const st = $("aiStatus");
  st.textContent = ok ? "● IA conectada" : "IA no disponible";
  st.classList.toggle("live", ok);
  if (msg) $("helpLine").textContent = msg;
}

/* ================= Criteria ================= */
function yearsAgo(fecha) { const t = new Date(fecha + "T12:00:00").getTime(); return isFinite(t) ? (Date.now() - t) / 31557600000 : 99; }
function autenticidad(e) {
  const art = (e.artefactos || []).some((a) => a.origen !== "cv"), conf = e.verificacion?.estado === "confirmada";
  if (art && conf) return 3; if (conf || art) return 2;
  if (e.contexto && e.fecha && e.horas > 0) return 1; return 0;
}
function vigencia(e) { const y = yearsAgo(e.fecha); return y <= 2 ? 3 : y <= VIGENCIA_YEARS ? 2 : y <= 10 ? 1 : 0; }
/** An official certificate (degree, language certificate, course…) is already the proof: it is not scored like a
    self-reported experience, and it does not go stale (a degree or a C1 certificate keeps its validity). */
const oficialValido = (e) => !!e.oficial;
function scoresOf(e) { if (oficialValido(e)) return { validez: 3, suficiencia: 3, autenticidad: 3, vigencia: 3 }; return { validez: clamp03(e.criterios?.validez), suficiencia: clamp03(e.criterios?.suficiencia), autenticidad: autenticidad(e), vigencia: vigencia(e) }; }
function outcomeStatus(ra, evs) {
  const linked = evs.filter((e) => (e.resultados || []).includes(ra.id));
  const checks = {
    cantidad: linked.length >= 2,
    producto: linked.some((e) => (e.artefactos || []).length),
    tercero: linked.some((e) => e.verificacion?.estado === "confirmada"),
    profundidad: linked.some((e) => { const s = scoresOf(e); return s.validez >= 2 && s.suficiencia >= 2; }),
    vigente: linked.some((e) => vigencia(e) >= 2),
  };
  const n = Object.values(checks).filter(Boolean).length;
  const horas = linked.reduce((a, e) => a + num(e.horas), 0);
  const label = !linked.length ? "Sin evidencias" : n === 5 ? "Lista para presentar" : n >= 3 ? "Casi lista" : "En construcción";
  return { linked, checks, n, horas, label, cls: n === 5 ? "ok" : n >= 3 ? "warn" : "" };
}
const totalHours = (evs) => evs.reduce((a, e) => a + num(e.horas), 0);
const ectsRange = (h) => [h / HOURS_PER_ECTS_MAX, h / HOURS_PER_ECTS_MIN];
const targetName = (obj) => (obj.sinObjetivo || !obj.resultados?.length ? "todavía sin asignatura del catálogo oficial" : [obj.asignatura, obj.titulacion, obj.universidad].filter(Boolean).join(" · "));

/* ================= Rule-based fallback (used when the AI is unavailable) ================= */
const stop = new Set("sobre porque para desde hasta entre cuando donde como cual cuales este esta estos estas unos unas otros otras pero puede pueden hacer tiene tienen seria habia algo esto aquello mediante despues antes siempre nunca mucho pocos forma manera idea tema contenido podcast libro video articulo experiencia aprendizaje concepto ejemplo importante central principal realmente aprendido creo pienso parece entiendo habla trata explica segun tambien entonces haber sido estoy somos utiliza diversos".split(" "));
function concepts(t, n = 4) { const w = normalize(t).replace(/https?:\/\/\S+/g, " ").match(/[a-zñ]{5,}/g) || []; const f = {}; w.filter((x) => !stop.has(x)).forEach((x) => (f[x] = (f[x] || 0) + 1)); return Object.keys(f).sort((a, b) => f[b] - f[a]).slice(0, n); }
function topic(t) { const c = concepts(t); return c.length ? c.slice(0, 2).join(" y ") : "lo que acabas de contar"; }
function classify(t) {
  const n = normalize(t);
  if (/no se|ni idea|no recuerdo|no entiendo|no sabria|me cuesta/.test(n)) return "uncertain";
  if (/pero|sin embargo|aunque|problema|riesgo|limite|duda|critica/.test(n)) return "critical";
  if (/por ejemplo|en mi trabajo|en mi caso|en un proyecto|cuando hice/.test(n)) return "practical";
  if (/porque|debido|ya que|por eso|evidencia|demuestra/.test(n)) return "reasoning";
  return "explore";
}
function ruleQuestion(t) {
  const k = draft.turns.length;
  if (k === 2) return "¿En qué contexto ocurrió (trabajo, voluntariado, formación, vida diaria), más o menos cuándo, y cuántas horas le has dedicado?";
  if (k === 4) return "¿Qué producto concreto generaste que puedas adjuntar (un documento, informe, código, material…) y quién podría confirmar lo que hiciste? Dime su nombre y su rol.";
  const f = topic(t), bank = {
    uncertain: [`No pasa nada por no tenerlo claro. ¿Qué parte de «${f}» sí puedes explicar con tus palabras?`, `Probemos con algo concreto: ¿cuándo te encontraste con ${f} por última vez?`],
    critical: [`Has señalado una dificultad con ${f}. ¿Cómo la resolviste y qué harías distinto la próxima vez?`, `¿Qué objeción haría alguien experto a tu forma de abordar ${f}?`],
    practical: [`Ese caso ayuda. ¿Qué decisión tomaste en ${f} y con qué criterio?`, `¿Cómo supiste que lo que hiciste con ${f} funcionó? ¿Qué resultado observable hubo?`],
    reasoning: [`Explicas una causa sobre ${f}. ¿Qué dato o hecho concreto lo respalda?`, `¿En qué situación no funcionaría lo que propones sobre ${f}?`],
    explore: [`Has mencionado ${f}. ¿Puedes contarme un caso concreto en el que lo aplicaste?`, `Si tuvieras que enseñar ${f} a una persona nueva en tu equipo, ¿cómo lo explicarías?`, `¿Qué sabes hacer ahora con ${f} que antes no sabías?`],
  };
  let opts = bank[classify(t)].filter((q) => !draft.used.includes(q)); if (!opts.length) opts = bank[classify(t)];
  const q = opts[(k + concepts(t).join("").length) % opts.length]; draft.used.push(q); return q;
}
function ruleLink(text) {
  const words = concepts(text, 40);
  return objetivo.resultados.filter((r) => concepts(r.texto, 20).some((w) => words.some((x) => x.slice(0, 6) === w.slice(0, 6)))).map((r) => r.id);
}

/* ================= Chat ================= */
function bubble(text, who = "agent") {
  const div = document.createElement("div"); div.className = "msg " + who;
  div.innerHTML = `<div class="mini">${who === "agent" ? "✦" : "TÚ"}</div><div class="bubble"></div>`;
  div.querySelector(".bubble").textContent = text;
  $("messages").append(div); $("messages").scrollTop = $("messages").scrollHeight;
  return div.querySelector(".bubble");
}
function choices(items) {
  document.querySelectorAll(".choices").forEach((x) => x.remove());
  const box = document.createElement("div"); box.className = "choices";
  items.forEach((item) => { const b = document.createElement("button"); b.textContent = item; b.onclick = () => { box.remove(); submit(item); }; box.append(b); });
  $("messages").append(box); $("messages").scrollTop = $("messages").scrollHeight;
  if (!busy) persistDraft();
}
const PHASES = { intent: "Buscando qué puedes acreditar", start: "Preparado para acompañarte", type: "Eligiendo qué documentar", titleAsk: "Eligiendo qué documentar", dialogue: "Recogiendo evidencias", review: "Síntesis final", done: "Evidencia registrada" };
function setPhase() { $("phase").textContent = PHASES[stage] || "En conversación"; }
function ask(text, options) { bubble(text); setPhase(); if (options) choices(options); else persistDraft(); $("answer").focus(); }

let stage = "start", draft = null, busy = false;
function newDraft() {
  draft = { id: uid(), titulo: "", fuente: "", url: "", material: null, contexto: null, turns: [], used: [], history: [], createdAt: Date.now() };
}
const TYPE_OPTIONS = ["Una tarea de mi trabajo", "Un proyecto que llevé", "Un voluntariado", "Un curso, libro o podcast"];
function begin(seed) {
  newDraft();
  if (seed) { startTopic(seed); return; }
  stage = "type";
  if (chatAc()) {
    const o = subjectOf(acDe(chatAc()));
    ask(`¿Qué quieres documentar para «${o.asignatura}»? Cuéntame una experiencia en la que hayas puesto en práctica algo de esta asignatura, pega el enlace o el título de lo que viste, escuchaste o leíste, o adjunta el material con el clip 📎.`, TYPE_OPTIONS);
    return;
  }
  ask("¿Qué quieres hacer hoy? Cuéntame algo que hayas aprendido (una tarea del trabajo, un proyecto, un voluntariado, un curso o algo que resolviste en tu vida diaria), pega el enlace o el título de lo que viste, escuchaste o leíste, o adjunta el material con el clip 📎. También puedes decirme qué te gustaría acreditar.", [...TYPE_OPTIONS, "Quiero acreditar algo concreto"]);
}
function setBusy(b) { busy = b; $("send").disabled = b; if (!b) persistDraft(); }

/* Each accreditation has its own conversation; "hoy" is the general one. Only one is on screen at a time:
   the chat box moves between the «Hoy» view and the accreditation's workspace, and each conversation is
   saved on its own (the accreditation's in the database, the general one in this browser). */
let chatKey = "hoy";
const chats = {}, persistTimers = {};
const chatAc = () => (chatKey === "hoy" ? null : chatKey);
const hoyKey = () => "lumen_hoy_" + session.user.id;
function snapshotChat() {
  const keepDraft = draft && ["type", "titleAsk", "dialogue", "review"].includes(stage);
  return {
    msgs: [...$("messages").querySelectorAll(".msg")].filter((m) => !m.querySelector(".thinking")).slice(-60).map((m) => ({ who: m.classList.contains("user") ? "user" : "agent", text: m.querySelector(".bubble").textContent })),
    choices: [...$("messages").querySelectorAll(".choices button")].map((b) => b.textContent),
    draft: keepDraft ? draft : null, stage: keepDraft ? stage : stage === "done" ? "done" : "start", guardado: Date.now(),
  };
}
function persistDraft(now = false) {
  if (!session || !$("messages").childElementCount) return;
  const key = chatKey, snap = snapshotChat();
  chats[key] = snap;
  if (key === "hoy") { try { localStorage.setItem(hoyKey(), JSON.stringify(snap)); } catch {} return; }
  clearTimeout(persistTimers[key]);
  persistTimers[key] = setTimeout(() => saveChat(key), now ? 0 : 800);
}
function saveChat(key) {
  clearTimeout(persistTimers[key]); delete persistTimers[key];
  const ac = acDe(key); if (ac && chats[key]) updateAc(ac, { conversacion: chats[key] }).catch(() => {});
}
/** Saves pending conversations right away when the person leaves the page or switches tab. */
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") Object.keys(persistTimers).forEach(saveChat); });
function mountChat() {
  const slot = chatKey === "hoy" ? $("hoyChatSlot") : $("acChatSlot");
  if ($("chatBox").parentElement !== slot) slot.append($("chatBox"));
  $("chatTitle").textContent = chatKey === "hoy" ? "Entrevista de evidencias" : "Conversación · " + subjectOf(acDe(chatKey)).asignatura;
}
/** Shows the conversation of «hoy» or of one accreditation. Returns false while Lumen is still answering. */
function useChat(key) {
  if (key === chatKey && $("messages").childElementCount) { mountChat(); return true; }
  if (busy) return false;
  persistDraft(true);
  chatKey = key; mountChat();
  $("messages").innerHTML = "";
  let snap = chats[key];
  if (!snap) { if (key === "hoy") { try { snap = JSON.parse(localStorage.getItem(hoyKey())); } catch {} } else snap = acDe(key)?.conversacion; }
  draft = snap?.draft || null; stage = draft ? snap.stage : snap?.stage === "done" ? "done" : "start";
  if (snap?.msgs?.length) {
    for (const m of snap.msgs) bubble(m.text, m.who);
    if (key === "hoy" && !draft && Date.now() - (snap.guardado || 0) > 6 * 36e5) { proponer(`Hola de nuevo${perfil.nombre ? ", " + perfil.nombre.split(" ")[0] : ""}.`); return true; }
    if (draft && ["dialogue", "review"].includes(stage)) bubble(`Seguimos con «${draft.titulo}» donde lo dejaste. Si prefieres empezar otra cosa, escribe «empezar de nuevo».`);
    if (snap.choices?.length) choices(snap.choices);
    setPhase();
    if (draft?.history?.length && draft.history.at(-1).role === "user" && ["dialogue", "review"].includes(stage)) agentTurn(draft.history.at(-1).content, { closing: stage === "review" });
  } else greet(key);
  return true;
}
function greet(key) {
  if (key === "hoy") {
    if (!evidences.length && !tray().buscada) {
      bubble(`Hola${perfil.nombre ? ", " + perfil.nombre.split(" ")[0] : ""}. Soy Lumen. Te ayudo a convertir lo que aprendes cada día en evidencias que una universidad pueda reconocer.\n\nCuéntame algo que hayas hecho o aprendido y te haré preguntas hasta tener lo que pide un expediente: qué sabes hacer, un caso real, horas, un producto que lo pruebe y alguien que pueda confirmarlo.\n\nSi prefieres, empiezo cargando tu experiencia: tu currículum, lo que haya sobre ti en internet o los títulos y certificados que ya tienes.`);
      stage = "start"; setPhase();
      choices(["Cargar mi experiencia", "Subir títulos y certificados", "Empezar a documentar", "¿Qué es Lumen?"]);
      return;
    }
    proponer(`Hola${perfil.nombre ? ", " + perfil.nombre.split(" ")[0] : ""}. Lo que documentes aquí queda en tu trayectoria y lo vinculo a las acreditaciones de tu árbol.`);
    return;
  }
  const ac = acDe(key), o = subjectOf(ac), p = o.resultados.length ? progressOf(o, evsDe(key)) : null;
  const debil = p?.sts.filter((x) => x.s.n < 5).sort((a, b) => a.s.n - b.s.n)[0];
  bubble(`Esta es la conversación de «${o.asignatura}» (${o.titulacion}, ${o.universidad}). Aquí documentamos lo que te sirve para sus ${o.resultados.length} resultados de aprendizaje oficiales, y te preguntaré pensando en ellos.${p ? `\n\nLlevas un ${p.pct} %: ${p.ready} de ${p.sts.length} resultados listos para presentar.` : ""}${debil ? ` Lo que más te falta ahora es ${debil.r.id}: ${debil.r.texto}` : ""}\n\nCuéntame una experiencia, pega un enlace o adjunta material.`);
  stage = "start"; setPhase();
  choices(["Documentar una experiencia", "¿Qué me falta?", "Recomiéndame recursos"]);
}

async function agentTurn(userText, { closing = false } = {}) {
  const el = bubble("Pensando…"); el.classList.add("thinking"); setPhase(); setBusy(true);
  try {
    if (!aiOk) throw new Error("offline");
    const r = await api("/api/chat", { acreditacion_id: chatAc(), titulo: draft.titulo, history: draft.history, closing, fuente: draft.material && { path: draft.material.path, name: draft.material.name }, contexto: draft.contexto && { path: draft.contexto.path, name: draft.contexto.name } });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      el.classList.remove("thinking"); el.textContent = text; $("messages").scrollTop = $("messages").scrollHeight;
    }
    text = text.trim();
    if (!text) throw new Error("empty");
    el.textContent = text; draft.history.push({ role: "assistant", content: text });
    if (!$("aiStatus").classList.contains("live")) aiState(true, "Enter para enviar · Mayús+Enter para nueva línea · Entrevista guiada por Claude");
  } catch (e) {
    aiProblem(e);
    const q = closing ? closingQuestion() : ruleQuestion(userText);
    el.classList.remove("thinking"); el.textContent = q; draft.history.push({ role: "assistant", content: q });
  } finally { setBusy(false); $("answer").focus(); }
}
/** Starts the interview on a topic: reads a link if there is one, then the agent asks the first question. */
async function startTopic(value) {
  const m = value.match(/https?:\/\/\S+/);
  draft.titulo = draft.titulo || value.replace(/https?:\/\/\S+/g, "").trim() || value;
  stage = "dialogue";
  if (m) { draft.url = m[0]; await readLink(m[0]); }
  else if (!draft.material) await research(value);
  draft.history.push({ role: "user", content: value });
  await agentTurn(value);
}
/** Words that suggest the message names something that can be looked up online. */
const REFERENCE_HINT = /\b(busca|buscar|investiga|internet|google|proyecto|empresa|startup|asociaci[oó]n|fundaci[oó]n|cooperativa|ong|s\.?l\.?|s\.?a\.?|estudio|investigaci[oó]n|curso|m[aá]ster|libro|art[ií]culo|p[oó]dcast|programa|congreso|premio|publicaci[oó]n|app|plataforma)\b|www\.|\.(com|es|org|eus|net)\b/i;
/** Searches the web for what the person mentions and shows what it found, with sources, for them to confirm. */
async function research(texto) {
  if (!aiOk) return;
  const el = bubble("Buscando en internet…"); el.classList.add("thinking"); setBusy(true);
  try {
    const conversacion = draft.history.slice(-6).map((m) => (m.role === "user" ? "Persona: " : "Lumen: ") + m.content).join("\n");
    const r = await (await api("/api/investigar", { texto, draftId: draft.id, previo: draft.contexto?.path || "", conversacion })).json();
    if (r.nada) { el.closest(".msg").remove(); return; }
    draft.contexto = r.contexto;
    el.textContent = `He buscado en internet. ${r.resumen || "He encontrado información sobre lo que mencionas."}\n¿Es esto de lo que hablas? Si no, dímelo en tu respuesta.`;
    const list = document.createElement("div"); list.className = "sources";
    for (const f of r.fuentes || []) {
      const a = document.createElement("a"); a.href = f.url; a.target = "_blank"; a.rel = "noopener";
      try { a.textContent = (f.title || f.url).slice(0, 80) + " · " + new URL(f.url).hostname.replace(/^www\./, ""); } catch { a.textContent = f.url; }
      list.append(a);
    }
    el.append(list);
  } catch (e) {
    aiProblem(e);
    el.closest(".msg").remove();
  } finally { el.classList.remove("thinking"); setBusy(false); }
}
async function readLink(url) {
  const el = bubble("Abriendo el enlace…"); el.classList.add("thinking"); setBusy(true);
  try {
    const { fuente } = await (await api("/api/fuente", { url, draftId: draft.id })).json();
    draft.material = fuente;
    if (draft.titulo === url) draft.titulo = fuente.name;
    el.textContent = fuente.leido ? `He leído «${fuente.name}»${fuente.articulos ? ` y los ${fuente.articulos} artículos que enlaza` : ""}. Te preguntaré a partir de su contenido.`
      : fuente.tipo === "video" || fuente.tipo === "audio" ? `He identificado «${fuente.name}». No puedo ${fuente.tipo === "video" ? "ver el vídeo" : "escuchar el audio"}, así que te preguntaré a partir de lo que me cuentes.`
      : `No he podido leer el texto de «${fuente.name}» (quizá pide suscripción). Te preguntaré a partir de lo que me cuentes.`;
  } catch (e) {
    el.textContent = `No he podido abrir el enlace. ${e.message} Te preguntaré a partir de lo que me cuentes.`;
  } finally { el.classList.remove("thinking"); setBusy(false); }
}
/** Attaches a PDF or text file as the material the person learned from; the agent then asks about it. */
async function attachSource(file) {
  if (busy) return;
  document.querySelectorAll(".choices").forEach((x) => x.remove());
  if (!/\.(pdf|txt|md)$/i.test(file.name)) { bubble("Puedo leer archivos PDF o de texto (.txt, .md). Para otros formatos, pega un enlace o cuéntame de qué trata."); return; }
  if (file.size > 10 * 1024 * 1024) { bubble("El archivo supera los 10 MB. Adjunta solo la parte que te interesa."); return; }
  if (!draft || ["start", "done", "intent"].includes(stage)) newDraft();
  bubble("📎 " + file.name, "user");
  const el = bubble("Subiendo el archivo…"); el.classList.add("thinking"); setBusy(true);
  try {
    const a = await uploadFile(file, draft.id, "fuentes");
    draft.material = { name: file.name, path: a.path, tipo: /\.pdf$/i.test(file.name) ? "pdf" : "texto", leido: true };
    el.textContent = `He recibido «${file.name}». Te preguntaré a partir de su contenido.`;
  } catch (e) {
    el.textContent = e.message; return;
  } finally { el.classList.remove("thinking"); setBusy(false); }
  if (!draft.titulo) draft.titulo = file.name.replace(/\.[^.]+$/, "");
  stage = "dialogue";
  const msg = `He adjuntado «${file.name}», el contenido del que aprendí.`;
  draft.history.push({ role: "user", content: msg });
  await agentTurn(msg);
}
const closingQuestion = () => "Para cerrar: en dos o tres frases, ¿qué sabes hacer ahora, qué prueba lo demuestra mejor y qué te falta todavía? Si prefieres seguir profundizando, escribe «seguir».";

async function submit(value) {
  value = value.trim(); if (!value || busy) return;
  document.querySelectorAll(".choices").forEach((x) => x.remove());
  if (stage === "done" && value === "Ver mis evidencias") { if (chatAc()) setTab("evid"); else show("evidencias"); return; }
  if (value === "Ver propuestas de acreditación") { show("arbol"); $("propSection").scrollIntoView(); return; }
  if (value === "Cargar mi experiencia") { show("trayectoria"); return; }
  if (value === "¿Qué es Lumen?") { show("acerca"); return; }
  if (value === "Subir títulos y certificados") { show("evidencias"); $("certDrop").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (!chatAc() && (stage === "start" || stage === "done") && value !== "Empezar a documentar") {
    const c = cycleCards().find((x) => x.cta === value);
    if (c) { c.go(); return; }
  }
  if (value === "Abrir la acreditación" && lastAcCreada) { openAcreditacion(lastAcCreada); return; }
  if (stage === "done" && value === "Añadir a mi árbol" && lastPropuesta) {
    bubble(value, "user");
    const el = bubble("Añadiendo la acreditación y vinculando tus evidencias…"); el.classList.add("thinking"); setBusy(true);
    try {
      const ac = await adoptProposal(lastPropuesta.id);
      lastAcCreada = ac.id; lastPropuesta = null;
      el.textContent = `Hecho: «${subjectOf(ac).asignatura}» ya está en tu árbol, con ${evsDe(ac.id).length} evidencias vinculadas. Ábrela para trabajarla en su propia conversación.`;
      choices(["Abrir la acreditación", "Documentar otra cosa"]);
    } catch (e) { el.textContent = e.message; }
    finally { el.classList.remove("thinking"); setBusy(false); }
    return;
  }
  if (chatAc() && (stage === "start" || stage === "done")) {
    if (value === "Recomiéndame recursos") { setTab("ruta"); requestResources(); return; }
    if (value === "¿Qué me falta?") { bubble(value, "user"); explainGaps(); return; }
    if (value === "Documentar una experiencia") { bubble(value, "user"); begin(); return; }
  }
  bubble(value, "user"); $("answer").value = "";
  if (/^empezar de nuevo\.?$/.test(normalize(value))) { draft = null; stage = "start"; persistDraft(); begin(); return; }
  if ((stage === "start" || stage === "done") && value === "Quiero acreditar algo concreto" && !chatAc()) { stage = "type"; }
  if (stage === "start" || stage === "done") {
    if (/^(empezar|documentar)/.test(normalize(value))) { begin(); return; }
    begin(value); return;
  }
  if (stage === "type" && value === "Quiero acreditar algo concreto") {
    stage = "intent"; ask("¿Qué te gustaría que te reconocieran? Dímelo con tus palabras: una asignatura, una titulación o una competencia."); return;
  }
  if (stage === "intent") {
    const el = bubble("Buscando en las universidades cómo encaja con lo que has documentado… Puede tardar uno o dos minutos."); el.classList.add("thinking"); setBusy(true);
    try {
      const list = await requestProposals(value);
      const p = list?.find((x) => x.origen === "usuario" && x.estado === "nueva");
      el.classList.remove("thinking");
      lastPropuesta = p || null;
      el.textContent = p ? `Encaja «${p.asignatura}» (${p.titulacion}, ${p.universidad}, ${fmtN(p.ects)} ECTS)${p.convenio ? ", una universidad con convenio con Lumen" : ", una asignatura real de un título oficial; esa universidad aún no tiene convenio con Lumen"}. Con lo que has documentado, cubres un ${p.encaje} % de sus resultados de aprendizaje. ${p.motivo}${p.siguientes_pasos?.[0] ? "\n\nPrimer paso: " + p.siguientes_pasos[0] : ""}${lastNoMatch ? "\n\n" + lastNoMatch : ""}\n\n¿La añado a tu árbol de acreditaciones? Tendrá su propia conversación, sus evidencias y su recorrido.` : `${lastNoMatch || "No he encontrado esa asignatura en el catálogo oficial de Lumen."} Puedes pedir a la coordinación que la añada desde «Mis acreditaciones».`;
      stage = "done"; setPhase(); choices(p ? ["Añadir a mi árbol", "Ver propuestas de acreditación", "Documentar otra cosa"] : ["Ver propuestas de acreditación", "Documentar otra cosa"]);
    } catch (e) {
      el.classList.remove("thinking"); el.textContent = e.message + " Puedes elegir la asignatura a mano en «Mis acreditaciones».";
      stage = "done"; choices(["Ver propuestas de acreditación", "Documentar otra cosa"]);
    } finally { setBusy(false); }
    return;
  }
  if (stage === "type") {
    if (/^(una tarea de mi trabajo|un proyecto que lleve|un voluntariado|un curso, libro o podcast)$/.test(normalize(value))) {
      draft.fuente = value; stage = "titleAsk"; ask(normalize(value).startsWith("un curso") ? "Perfecto. Pega el enlace o escribe el título y el autor. Si tienes el material en PDF, adjúntalo con el clip 📎." : "Perfecto. Descríbelo en una frase: ¿qué era y qué hiciste tú?"); return;
    }
    await startTopic(value); return;
  }
  if (stage === "titleAsk") { await startTopic(value); return; }
  if (stage === "dialogue") {
    if (REFERENCE_HINT.test(value)) await research(value);
    draft.turns.push({ text: value }); draft.history.push({ role: "user", content: value });
    if (draft.turns.length >= MAX_TURNS) { stage = "review"; await agentTurn(value, { closing: true }); return; }
    await agentTurn(value); return;
  }
  if (stage === "review") {
    draft.history.push({ role: "user", content: value });
    if (/^(seguir|continuar|profundizar)/.test(normalize(value))) { stage = "dialogue"; draft.turns.push({ text: value }); await agentTurn(value); return; }
    draft.turns.push({ text: value });
    await completeInterview(value);
  }
}

async function analyzeInterview(synthesis) {
  const userText = draft.turns.map((t) => t.text).join(" ");
  const fallback = { titulo: "", evidencias: { sintesis: synthesis }, resultados: ruleLink(userText + " " + draft.titulo), validez: 1, suficiencia: userText.length > 900 ? 2 : 1, contexto: "", horas: 0, fecha: "", verificador_nombre: "", verificador_rol: "", falta: "Añade un producto y la confirmación de alguien que haya visto tu trabajo." };
  if (!aiOk) return fallback;
  try {
    const o = await (await api("/api/analyze", { kind: "interview", acreditacion_id: chatAc(), titulo: draft.titulo, history: draft.history, fuente: draft.material && { path: draft.material.path, name: draft.material.name }, contexto: draft.contexto && { path: draft.contexto.path, name: draft.contexto.name } })).json();
    const ev = {}; for (const k of ["idea", "aplicacion", "argumentacion", "conexion", "limites", "fidelidad"]) if (o.evidencias?.[k]?.trim()) ev[k] = o.evidencias[k].trim();
    ev.sintesis = synthesis;
    return { ...o, evidencias: ev };
  } catch (e) {
    aiProblem(e);
    return fallback;
  }
}

async function completeInterview(synthesis) {
  const el = bubble("Ordenando tus evidencias…"); el.classList.add("thinking"); setBusy(true);
  const r = await analyzeInterview(synthesis);
  const e = {
    id: draft.id, kind: "evidence", tipo: "entrevista", titulo: r.titulo || draft.titulo, fuente: draft.fuente, url: draft.url, material: draft.material, contexto_web: draft.contexto,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(r.fecha) ? r.fecha : today(), createdAt: draft.createdAt,
    contexto: CONTEXTOS.includes(r.contexto) ? r.contexto : "", horas: num(r.horas), resultados: r.resultados || [], evidencias: r.evidencias,
    criterios: { validez: clamp03(r.validez), suficiencia: clamp03(r.suficiencia) }, falta: r.falta || "",
    artefactos: [], verificacion: { nombre: r.verificador_nombre || "", rol: r.verificador_rol || "", contacto: "", estado: "sin solicitar" },
    dialogue: draft.history.map((m) => ({ role: m.role, text: m.content })), ai: aiOk,
  };
  const ac = chatAc();
  if (ac) { e.acreditacion_origen = ac; e.vinculos = { [ac]: e.resultados }; }
  el.classList.remove("thinking");
  try {
    await saveEvidence(e);
    el.textContent = `He registrado «${e.titulo}» como evidencia${ac && e.resultados.length ? " para " + e.resultados.join(", ") : ""}.${e.falta ? "\n\nPara que sea suficiente: " + e.falta : ""}\n\nEn ${ac ? "la pestaña «Evidencias»" : "«Mis evidencias»"} puedes adjuntar el producto, revisar las horas y pedir la confirmación de ${e.verificacion.nombre || "alguien que haya visto tu trabajo"}.${acreditaciones.length > (ac ? 1 : 0) ? " Lumen también la está vinculando a las demás acreditaciones de tu árbol." : ""}`;
    stage = "done"; draft = null; setPhase(); choices(["Ver mis evidencias", "Documentar otra cosa"]);
    vincularEnArbol(e, ac ? [ac] : []);
    maybeAutoPropose();
  } catch (err) {
    el.textContent = err.message + " Escribe tu síntesis otra vez para reintentarlo.";
    draft.turns.pop(); draft.history.pop();
  }
  setBusy(false);
}

/* ================= Diary ================= */
$("diaryForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = $("dText").value.trim(); if (!text) return;
  const btn = $("dSave"); btn.disabled = true; btn.textContent = "Guardando…"; $("dToast").textContent = "";
  const id = uid(), f = $("dFile").files?.[0];
  try {
    const artefactos = f ? [await uploadFile(f, id)] : [];
    let link = { titulo: text.split(/[.!?\n]/)[0].slice(0, 70), resultados: [], validez: 1, suficiencia: text.length > 400 ? 2 : 1, falta: "Amplíala con una entrevista para ganar profundidad." };
    if (aiOk) {
      try { link = { ...(await (await api("/api/analyze", { kind: "diary", texto: text, contexto: $("dCtx").value, horas: num($("dHours").value) })).json()), resultados: [] }; }
      catch (e) { if (e.status === 429 || e.status === 403) aiState(false, e.message); }
    }
    await saveEvidence({
      id, kind: "evidence", tipo: "diario", titulo: link.titulo || text.slice(0, 70), fuente: "", url: "", fecha: $("dDate").value || today(), createdAt: Date.now(),
      contexto: $("dCtx").value, horas: num($("dHours").value), resultados: link.resultados || [], evidencias: { texto: text },
      criterios: { validez: clamp03(link.validez), suficiencia: clamp03(link.suficiencia) }, falta: link.falta || "",
      artefactos, verificacion: { nombre: "", rol: "", contacto: "", estado: "sin solicitar" }, dialogue: [], ai: aiOk,
    });
    if (artefactos[0]) {
      const e = evidences.find((x) => x.id === id), lectura = await reviewArtefactAI(e, artefactos[0]);
      if (lectura) await saveEvidence({ ...structuredClone(e), artefactos: [{ ...artefactos[0], lectura }] });
    }
    $("dText").value = ""; $("dFile").value = ""; $("dHours").value = "1"; $("dDate").value = today();
    $("dToast").textContent = acreditaciones.length ? "Guardado. Lumen lo está vinculando a tus acreditaciones…" : "Guardado en tu trayectoria.";
    const nueva = evidences.find((x) => x.id === id);
    if (nueva) vincularEnArbol(nueva).then(() => { const v = evidences.find((x) => x.id === id)?.vinculos || {}; const n = Object.keys(v).length; if (acreditaciones.length) $("dToast").textContent = n ? `Guardado · cuenta para ${n} acreditaci${n === 1 ? "ón" : "ones"} de tu árbol` : "Guardado en tu trayectoria."; });
    maybeAutoPropose();
  } catch (e) {
    $("dToast").textContent = e.message;
  } finally { btn.disabled = false; btn.textContent = "Guardar en el diario"; }
});

/* ================= Official accreditation ================= */
/** Course-like progress: each learning outcome counts by how many of its five checks are met. */
function progressOf(obj, evs) {
  const sts = obj.resultados.map((r) => ({ r, s: outcomeStatus(r, evs) }));
  const pct = sts.length ? Math.round((sts.reduce((a, x) => a + x.s.n, 0) / (sts.length * 5)) * 100) : 0;
  const linked = evs.filter((e) => (e.resultados || []).some((id) => obj.resultados.some((r) => r.id === id)));
  return { sts, pct, ready: sts.filter((x) => x.s.n === 5).length, horas: totalHours(linked), carga: [Number(obj.ects) * HOURS_PER_ECTS_MIN, Number(obj.ects) * HOURS_PER_ECTS_MAX] };
}
function progressHtml(obj, evs, { compact = false } = {}) {
  if (obj.sinObjetivo || !obj.resultados.length) return compact ? '<p class="subtle">Elige una asignatura del catálogo oficial para ver tu progreso.</p>' : "";
  const p = progressOf(obj, evs);
  return `<div class="progress">
    <div class="progress-top"><strong>${p.pct} %</strong><small>${p.ready} de ${p.sts.length} resultados de aprendizaje listos para presentar</small></div>
    <span class="track" style="display:block"><span class="fill${p.pct === 100 ? " ok" : ""}" style="display:block;width:${p.pct}%"></span></span>
    <small>${fmtN(p.horas)} h documentadas de las ${fmtN(p.carga[0])}–${fmtN(p.carga[1])} h de trabajo que supone la asignatura (${fmtN(obj.ects)} ECTS a 25–30 h por crédito)</small>
    ${compact ? "" : `<ul class="ra-list">${p.sts.map(({ r, s }) => `<li><b>${safe(r.id)}</b><span>${safe(r.texto)}</span><span class="pill ${s.cls}">${s.n}/5</span></li>`).join("")}</ul>`}
  </div>`;
}
const convenioPill = (estado) => estado === "publicada" ? '<span class="pill ok">Con convenio Lumen</span>' : estado === "detectada" ? '<span class="pill warn" title="Asignatura real de un título oficial. Lumen gestionará el acuerdo con la universidad.">Sin convenio todavía</span>' : "";
function subjectFacts(o) {
  return [o.nivel, o.ects && fmtN(o.ects) + " ECTS", o.caracter, o.curso_academico && "Curso " + o.curso_academico, o.codigo_asignatura && "Código " + o.codigo_asignatura, o.codigo_ruct && "RUCT " + o.codigo_ruct].filter(Boolean).map((x) => `<span class="pill">${safe(x)}</span>`).join("");
}
/** «Recorrido»: progress per official outcome and the evidences that got the person here, in time order. */
function renderMiAcreditacion() {
  const box = $("miAcreditacion"), ac = acDe(acActual);
  if (!ac) { box.innerHTML = ""; return; }
  const o = objetivo, evs = evsDe(ac.id), sorted = [...evs].sort(byDate);
  box.innerHTML = `<h2>Tu recorrido</h2>
    <p class="note">Cómo avanzas en cada resultado de aprendizaje oficial de la asignatura. Cada uno queda listo para presentar con cinco comprobaciones: al menos dos evidencias, un producto, la confirmación de un tercero, profundidad suficiente y vigencia.</p>
    <div class="subject">
      <div class="facts">${convenioPill(o.estado)}${subjectFacts(o)}</div>
      ${o.estado === "detectada" ? '<p class="note">Es una asignatura real de un título oficial, pero esta universidad aún no tiene convenio con Lumen. Lumen gestionará el acuerdo; mientras tanto, todo lo que documentes ya cuenta para tu expediente.</p>' : ""}
      ${o.estado === "retirada" ? '<p class="falta">Esta asignatura ya no está en el catálogo. Consulta con la coordinación o quítala de tu árbol.</p>' : ""}
      ${progressHtml(o, evs)}
    </div>
    <h3 style="margin-top:22px">Cómo has llegado hasta aquí</h3>
    ${sorted.length ? `<ol class="ac-path">${sorted.map((e) => `<li><span class="subtle">${safe(fmtDate(e.fecha))}</span><b>${safe(e.titulo)}</b><span class="chips">${e.resultados.map((id) => `<span class="pill ra">${safe(id)}</span>`).join("") || '<span class="pill">Sin resultado vinculado</span>'}${e.acreditacion_origen === ac.id ? '<span class="pill">De esta conversación</span>' : ""}</span></li>`).join("")}</ol>` : '<div class="empty">Todavía no hay evidencias para esta acreditación. Empieza en la pestaña «Conversación» o pulsa «Buscar en mi trayectoria lo que sirve aquí» en «Evidencias».</div>'}`;
}
function renderCatalog() {
  const q = normalize($("catSearch").value.trim());
  const list = catalogo.filter((a) => ["publicada", "detectada"].includes(a.estado) && (!q || normalize(`${a.asignatura} ${a.titulacion} ${a.universidad} ${a.codigo_asignatura}`).includes(q)));
  $("catList").innerHTML = list.length ? list.slice(0, 50).map((a) => { const ac = acreditaciones.find((x) => x.asignatura_id === a.id); return `<div class="cat-row"><div style="min-width:0"><b>${safe(a.asignatura)}</b><small>${safe(a.titulacion)} · ${safe(a.universidad)} · ${fmtN(Number(a.ects))} ECTS · ${a.resultados.length} resultados de aprendizaje</small></div>
    <div class="row-actions" style="margin-top:0">${convenioPill(a.estado)}<a class="btn small" href="${safe(a.fuente_url)}" target="_blank" rel="noopener">Guía ↗</a>${ac ? `<button class="btn small" data-ac="${safe(ac.id)}">En tu árbol · abrir</button>` : `<button class="btn small accent" data-choose="${safe(a.id)}">Añadir a mi árbol</button>`}</div></div>`; }).join("")
    : `<div class="empty">${catalogo.some((a) => ["publicada", "detectada"].includes(a.estado)) ? "Ninguna asignatura coincide con la búsqueda." : "Todavía no hay asignaturas aquí. Di arriba qué quieres acreditar o pulsa «Que Lumen proponga con mis evidencias»: Lumen las buscará en las universidades."}</div>`;
}
$("catSearch").addEventListener("input", renderCatalog);
$("catList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-choose]"); if (!b) return;
  const a = catalogo.find((x) => x.id === b.dataset.choose); if (!a) return;
  b.disabled = true; b.textContent = "Añadiendo y vinculando tus evidencias…";
  try { const ac = await createAcreditacion(a); openAcreditacion(ac.id); }
  catch (e) { b.disabled = false; b.textContent = "Añadir a mi árbol"; $("intentMsg").textContent = e.message; }
});
$("requestForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const { error } = await sb.from("solicitudes_catalogo").insert({ texto: $("reqText").value.trim(), url: $("reqUrl").value.trim() });
  $("reqMsg").textContent = error ? "No se pudo enviar. Inténtalo de nuevo." : "Enviado. La coordinación revisará la guía docente y la añadirá si es posible.";
  if (!error) { $("reqText").value = ""; $("reqUrl").value = ""; }
});

/* ================= Accreditation proposals ================= */
const AUTO_PROPOSE_EVERY = 3;
let proposing = false, lastNoMatch = "", lastPropuesta = null, lastAcCreada = null;
const enArbol = (asignaturaId) => acreditaciones.find((x) => x.asignatura_id === asignaturaId);
const propuestas = () => perfil?.propuestas || [];
const nuevasLumen = () => propuestas().filter((p) => p.estado === "nueva" && p.origen === "lumen");

async function requestProposals(intencion) {
  if (proposing) return null;
  proposing = true;
  try {
    const { propuestas: list, sin_coincidencia } = await (await api("/api/analyze", { kind: "propose", intencion: intencion || "" })).json();
    perfil.propuestas = list;
    lastNoMatch = sin_coincidencia || "";
    await loadCatalog().catch(() => {});
    perfil.propuestas_n_evidencias = evidences.length;
    render();
    return list;
  } finally { proposing = false; }
}
/** Proactive: after every few new evidences, Lumen looks for accreditations on its own. */
async function maybeAutoPropose() {
  if (!aiOk || proposing || evidences.length < 2) return;
  if (evidences.length - (perfil.propuestas_n_evidencias || 0) < AUTO_PROPOSE_EVERY) return;
  try {
    const list = await requestProposals("");
    const best = list?.find((p) => p.origen === "lumen" && p.estado === "nueva" && !enArbol(p.asignatura_id));
    if (best) {
      bubble(`Mientras documentabas, he revisado tus ${evidences.length} evidencias. Encajan con «${best.asignatura}» (${best.titulacion}): ya cubres un ${best.encaje} %. ${best.motivo}`);
      // Keep whatever options the chat was already offering (e.g. after closing an interview).
      const previas = [...document.querySelectorAll(".choices button")].map((b) => b.textContent).filter((t) => t !== "Ver propuestas de acreditación");
      choices(["Ver propuestas de acreditación", ...previas]);
    }
  } catch (e) { if (e.status === 429 || e.status === 403) aiState(false, e.message); /* 409: empty catalog, nothing to propose yet */ }
}
async function adoptProposal(id) {
  const p = propuestas().find((x) => x.id === id); if (!p) return;
  if (!catalogo.some((x) => x.id === p.asignatura_id)) await loadCatalog();
  const a = catalogo.find((x) => x.id === p.asignatura_id && ["publicada", "detectada"].includes(x.estado));
  if (!a) throw new Error("Esa asignatura ya no está en el catálogo.");
  await updatePerfil({ propuestas: propuestas().map((x) => (x.id === id ? { ...x, estado: "adoptada" } : x)) });
  return createAcreditacion(a, p.cobertura);
}
async function discardProposal(id) {
  await updatePerfil({ propuestas: propuestas().filter((x) => x.id !== id) });
  render();
}
function renderProposals() {
  const list = propuestas().filter((p) => p.asignatura_id);
  const nuevas = nuevasLumen().filter((p) => !enArbol(p.asignatura_id)).length;
  $("propBadge").hidden = !nuevas; $("propBadge").textContent = nuevas;
  if (!list.length) {
    $("propList").innerHTML = `<div class="empty">${evidences.length < 2 ? "Cuando tengas al menos dos evidencias, Lumen te propondrá acreditaciones por su cuenta. También puedes decirle arriba qué quieres acreditar." : "Aún no hay propuestas. Pulsa «Que Lumen proponga con mis evidencias» o di arriba qué quieres acreditar."}</div>`;
    return;
  }
  const evTitle = (id) => evidences.find((e) => e.id === id)?.titulo || "evidencia";
  $("propList").innerHTML = list.map((p) => {
    const covered = (p.cobertura || []).filter((c) => c.evidencias.length).length;
    const ac = enArbol(p.asignatura_id);
    return `<article class="prop${ac ? " adoptada" : ""}">
      <div class="prop-head"><div style="min-width:0"><b>${safe(p.asignatura)}</b><small class="subtle">${safe(p.titulacion)} · ${safe(p.universidad)}${p.ects ? " · " + fmtN(p.ects) + " ECTS" : ""} · <a href="${safe(p.fuente_url)}" target="_blank" rel="noopener">guía docente oficial</a></small></div>
        <span class="facts">${p.convenio ? '<span class="pill ok">Con convenio Lumen</span>' : '<span class="pill warn">Sin convenio todavía</span>'}<span class="pill">${ac ? "En tu árbol" : p.origen === "usuario" ? "Lo que pediste" : "Propuesta de Lumen"}</span></span></div>
      ${p.intencion ? `<p class="subtle">Pediste: «${safe(p.intencion)}»</p>` : ""}
      <div class="fit"><strong>${p.encaje} %</strong><div><span class="track" style="display:block"><span class="fill${p.encaje >= 70 ? " ok" : ""}" style="display:block;width:${p.encaje}%"></span></span>de encaje · ${covered} de ${p.resultados.length} resultados con evidencias</div></div>
      <p>${safe(p.motivo)}</p>
      <details class="more"><summary>Resultados de aprendizaje y qué los respalda</summary>
        <div class="ra-cover" style="margin-top:8px">${p.resultados.map((r) => { const ev = p.cobertura?.find((c) => c.resultado_id === r.id)?.evidencias || []; return `<div><span class="${ev.length ? "yes" : "no"}">${ev.length ? "✓" : "—"}</span><span><b>${safe(r.id)}</b> ${safe(r.texto)}${ev.length ? `<br><small class="subtle">${ev.map((id) => safe(evTitle(id))).join(" · ")}</small>` : ""}</span></div>`; }).join("")}</div>
      </details>
      ${p.siguientes_pasos?.length ? `<div><b style="font-size:13px">Para completarla</b><ul>${p.siguientes_pasos.map((x) => `<li>${safe(x)}</li>`).join("")}</ul></div>` : ""}
      <div class="row-actions" style="margin-top:0">${ac ? `<button class="btn small" data-ac="${safe(ac.id)}">Abrir en mi árbol</button>` : `<button class="btn small accent" data-prop="adopt" data-id="${safe(p.id)}">Añadir a mi árbol</button><button class="btn small" data-prop="discard" data-id="${safe(p.id)}">Descartar</button>`}</div>
    </article>`;
  }).join("");
}
$("propList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-prop]"); if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.prop === "adopt") { b.textContent = "Añadiendo y vinculando tus evidencias…"; const ac = await adoptProposal(b.dataset.id); openAcreditacion(ac.id); }
    else await discardProposal(b.dataset.id);
  } catch (e) { b.disabled = false; $("intentMsg").textContent = e.message || "No se pudo guardar. Inténtalo de nuevo."; }
});
async function runProposal(intencion, btn) {
  const msg = $("intentMsg"), label = btn.textContent;
  if (!aiOk) { msg.textContent = "La IA no está disponible ahora mismo."; return; }
  btn.disabled = true; btn.textContent = "Buscando en las universidades…"; msg.textContent = "Si no hay convenios que encajen, Lumen busca asignaturas reales en universidades españolas. Puede tardar uno o dos minutos.";
  try {
    const list = await requestProposals(intencion);
    msg.textContent = lastNoMatch || (list?.length ? "Propuestas actualizadas." : "No he encontrado asignaturas del catálogo que encajen.");
    $("propSection").scrollIntoView({ behavior: "smooth" });
  } catch (e) { msg.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = label; }
}
$("intentForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const t = $("intentText").value.trim();
  if (!t) { $("intentMsg").textContent = "Escribe qué quieres acreditar."; return; }
  runProposal(t, $("intentBtn"));
});
$("discoverBtn").onclick = () => runProposal("", $("discoverBtn"));

/* ================= Views ================= */
const TITLES = { agente: ["Plataforma de evidencias de aprendizaje", "¿Qué has aprendido hoy?"], trayectoria: ["Mi trayectoria", "Todo lo que ya has hecho, en un solo sitio."], evidencias: ["Evidencias", "Cada aprendizaje, con sus pruebas."], arbol: ["Mis acreditaciones", "Tu árbol de acreditaciones."], acreditacion: ["Mis acreditaciones", ""], coordinacion: ["Coordinación", "Seguimiento del piloto."], cuenta: ["Mi perfil", "Quién eres y lo que has construido."], acerca: ["Qué es Lumen", "Del día a día al crédito."] };
function show(id) {
  if (id === "acreditacion" && !acDe(acActual)) id = "arbol";
  if ((id === "agente" || id === "acreditacion") && !useChat(id === "agente" ? "hoy" : acActual)) {
    $("helpLine").textContent = "Espera a que Lumen termine de responder antes de cambiar de conversación.";
    return false;
  }
  vista = id;
  objetivo = id === "acreditacion" ? subjectOf(acDe(acActual)) : NO_OBJ;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === id));
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === (id === "acreditacion" ? "arbol" : id)));
  $("eyebrow").textContent = TITLES[id][0]; $("pagetitle").textContent = id === "acreditacion" ? objetivo.asignatura : TITLES[id][1];
  if (id === "cuenta") fillPerfil();
  if (id === "coordinacion") { loadPeople(); loadCoordCatalog(); }
  render(); window.scrollTo(0, 0);
  return true;
}
document.querySelectorAll("[data-view]").forEach((x) => (x.onclick = () => show(x.dataset.view)));
document.querySelectorAll("[data-goto]").forEach((x) => (x.onclick = () => show(x.dataset.goto)));
document.querySelectorAll("[data-go-chat]").forEach((x) => (x.onclick = () => { if (show("agente") && !busy) { bubble("Quiero documentar algo nuevo.", "user"); begin(); } }));

/* ================= One accreditation: conversation, evidences, path and dossier ================= */
let acTab = "chat";
function openAcreditacion(id, tab = "chat") {
  if (!acDe(id)) return;
  const prev = acActual; acActual = id;
  if (!show("acreditacion")) { acActual = prev; return; }
  setTab(tab);
}
function setTab(t) {
  acTab = t;
  document.querySelectorAll("#acTabs [data-tab]").forEach((b) => { b.classList.toggle("on", b.dataset.tab === t); b.setAttribute("aria-selected", b.dataset.tab === t); });
  document.querySelectorAll("#acreditacion .tabpanel").forEach((p) => p.classList.toggle("on", p.dataset.panel === t));
  render();
  if (t === "chat") $("answer").focus();
}
$("acTabs").addEventListener("click", (ev) => { const b = ev.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-ac]"); if (!b) return;
  openAcreditacion(b.dataset.ac);
});
const leafProgress = (ac) => { const o = subjectOf(ac); return o.resultados.length ? progressOf(o, evsDe(ac.id)) : { pct: 0, ready: 0, sts: [] }; };
function renderArbol() {
  const box = $("arbolTree");
  if (faltaTabla) { box.innerHTML = '<div class="empty">Falta un paso de instalación: hay que ejecutar <b>supabase/007_acreditaciones.sql</b> en Supabase. Mientras tanto no se pueden guardar acreditaciones.</div>'; return; }
  if (!acreditaciones.length) { box.innerHTML = '<div class="empty">Tu árbol todavía está vacío. Añade abajo tu primera acreditación: di a Lumen qué quieres acreditar, deja que te proponga una con tus evidencias o elígela en la lista.</div>'; return; }
  const ramas = new Map();
  for (const ac of acreditaciones) { const o = subjectOf(ac), k = `${o.titulacion}|${o.universidad}`; ramas.set(k, [...(ramas.get(k) || []), ac]); }
  box.innerHTML = [...ramas.entries()].map(([k, list]) => { const [tit, uni] = k.split("|"); return `<div class="branch">
      <div class="branch-head"><span aria-hidden="true">🎓</span><div style="min-width:0"><b>${safe(tit || "Titulación")}</b><small class="subtle">${safe(uni)}</small></div></div>
      <div class="leaves">${list.map((ac) => { const o = subjectOf(ac), p = leafProgress(ac), n = evsDe(ac.id).length; return `<button class="leaf" data-ac="${safe(ac.id)}">
        <span class="leaf-top"><b>${safe(o.asignatura)}</b>${convenioPill(o.estado)}</span>
        <span class="track" style="display:block"><span class="fill${p.pct === 100 ? " ok" : ""}" style="display:block;width:${p.pct}%"></span></span>
        <small class="subtle">${p.pct} % · ${p.ready} de ${p.sts.length} resultados listos · ${n} evidencia${n === 1 ? "" : "s"}${o.ects ? " · " + fmtN(o.ects) + " ECTS" : ""}</small>
        <span class="leaf-go">Abrir conversación →</span></button>`; }).join("")}</div></div>`; }).join("");
}
function renderMiniArbol() {
  $("miniArbol").innerHTML = acreditaciones.length ? acreditaciones.map((ac) => { const o = subjectOf(ac), p = leafProgress(ac); return `<button class="mini-leaf" data-ac="${safe(ac.id)}"><span class="mini-leaf-t"><b>${safe(o.asignatura)}</b><small class="subtle">${safe(o.titulacion)}</small></span><span class="track" style="display:block"><span class="fill${p.pct === 100 ? " ok" : ""}" style="display:block;width:${p.pct}%"></span></span><small class="subtle">${p.pct} %</small></button>`; }).join("")
    : '<p class="subtle">Todavía no tienes ninguna. Lumen te propondrá acreditaciones a medida que documentes, o puedes elegirlas tú.</p>';
}
function renderAcreditacion() {
  const ac = acDe(acActual), o = (objetivo = subjectOf(ac)), evs = evsDe(ac.id), p = o.resultados.length ? progressOf(o, evs) : null;
  $("acHead").innerHTML = `<button class="btn small" type="button" data-goto-arbol>← Mi árbol</button>
    <div class="subject-head" style="margin-top:12px"><div style="min-width:0"><b>${safe(o.asignatura)}</b><small class="subtle">${safe(o.titulacion)} · ${safe(o.universidad)}</small></div>
      <div class="row-actions" style="margin-top:0">${convenioPill(o.estado)}${o.fuente_url ? `<a class="btn small" href="${safe(o.fuente_url)}" target="_blank" rel="noopener">Guía docente oficial ↗</a>` : ""}<button class="btn small" type="button" id="acRemove">Quitar de mi árbol</button></div></div>
    ${p ? `<div class="ac-progress"><span class="track" style="display:block"><span class="fill${p.pct === 100 ? " ok" : ""}" style="display:block;width:${p.pct}%"></span></span><small class="subtle">${p.pct} % · ${p.ready} de ${p.sts.length} resultados de aprendizaje listos · ${evs.length} evidencia${evs.length === 1 ? "" : "s"} · ${fmtN(p.horas)} h</small></div>` : ""}`;
  $("acEvidCount").textContent = evs.length;
  $("acSide").innerHTML = `<h3>Resultados de aprendizaje</h3><div class="subtle">Los de la guía docente oficial y cómo vas en cada uno. Lumen pregunta pensando en ellos.</div>
    <div class="ra-mini">${(p?.sts || []).map(({ r, s }) => `<div title="${safe(r.texto)}"><b>${safe(r.id)}</b><span class="track"><span class="fill${s.n === 5 ? " ok" : ""}" style="display:block;width:${s.n * 20}%"></span></span><span class="subtle">${s.n}/5</span></div>`).join("")}</div>
    <button class="btn block" type="button" data-tab-go="ruta" style="margin-top:12px">Ver mi recorrido →</button>
    <button class="btn block" type="button" data-tab-go="exp" style="margin-top:8px">Ver expediente →</button>`;
  renderEvidenceList($("acEvidenceList"), evs, o, true, { acId: ac.id });
  renderMiAcreditacion(); renderResources();
  $("dossierTitle").textContent = "Expediente · " + o.asignatura;
  $("dossierProgress").innerHTML = `<p class="note">${safe(o.titulacion)} · ${safe(o.universidad)}${o.fuente_url ? ` · <a href="${safe(o.fuente_url)}" target="_blank" rel="noopener">guía docente oficial</a>` : ""}</p>${progressHtml(o, evs, { compact: true })}`;
  $("dossierKpis").innerHTML = kpisHtml(o, evs);
  $("dossierMatrix").innerHTML = matrixHtml(o, evs);
}
$("acHead").addEventListener("click", async (ev) => {
  if (ev.target.closest("[data-goto-arbol]")) { show("arbol"); return; }
  const b = ev.target.closest("#acRemove"); if (!b) return;
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Pulsa otra vez: se borra su conversación (tus evidencias se quedan)"; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Quitar de mi árbol"; } }, 5000); return; }
  if (busy) return;
  b.disabled = true;
  try { const ac = acDe(acActual); if (chatKey === ac.id) { chatKey = "hoy"; $("messages").innerHTML = ""; } await removeAc(ac); acActual = null; show("arbol"); }
  catch (e) { b.disabled = false; b.textContent = e.message; }
});
$("acSide").addEventListener("click", (ev) => { const b = ev.target.closest("[data-tab-go]"); if (b) setTab(b.dataset.tabGo); });
$("acDocBtn").onclick = () => { setTab("chat"); if (!busy) { document.querySelectorAll(".choices").forEach((x) => x.remove()); bubble("Quiero documentar algo nuevo para esta acreditación.", "user"); begin(); } };
$("acRelinkBtn").onclick = async () => {
  const b = $("acRelinkBtn"), msg = $("acEvidMsg");
  if (!aiOk) { msg.textContent = "La IA no está disponible ahora mismo."; return; }
  b.disabled = true; msg.textContent = "Lumen está revisando toda tu trayectoria…";
  try { const n = await relinkAc(acActual); msg.textContent = n ? `${n} evidencia${n === 1 ? "" : "s"} más vinculada${n === 1 ? "" : "s"} a esta acreditación.` : "No he encontrado más evidencias que sirvan aquí."; }
  catch (e) { aiProblem(e); msg.textContent = e.message; }
  finally { b.disabled = false; }
};
const CHECK_TXT = { cantidad: "al menos dos evidencias", producto: "un producto adjunto", tercero: "la confirmación de un tercero", profundidad: "más profundidad (explicar, aplicar, dar ejemplos)", vigente: "una evidencia de los últimos cinco años" };
function explainGaps() {
  const p = progressOf(objetivo, evsDe(acActual));
  const faltan = p.sts.filter((x) => x.s.n < 5);
  bubble(!faltan.length ? "¡Tienes todos los resultados de aprendizaje listos! Descarga tu expediente en la pestaña «Expediente»." : `Esto es lo que te falta, del resultado más flojo al más avanzado:\n\n${faltan.sort((a, b) => a.s.n - b.s.n).map(({ r, s }) => `${r.id} (${s.n}/5) — ${r.texto}\nTe falta: ${Object.entries(s.checks).filter(([, ok]) => !ok).map(([k]) => CHECK_TXT[k]).join(", ")}.`).join("\n\n")}`);
  choices(["Documentar una experiencia", "Recomiéndame recursos"]);
}

let entered = false;
function enterApp() {
  showScreen("app");
  $("whoName").textContent = perfil.nombre || session.user.email;
  pintarAvatar($("avatar"));
  $("navCoord").hidden = perfil.role !== "coordinador";
  $("chatDrive").hidden = !googleCfg;
  $("dDate").value = today();
  if (!entered) {
    entered = true;
    useChat("hoy");
    if (!pendingTrace && !perfil.trayectoria?.buscada && !evidences.length) show("trayectoria"); else show("agente");
  } else render();
  if (pendingTrace) { const p = pendingTrace; pendingTrace = null; setTimeout(() => autoTraceOnSignup(p), 0); }
  alVolverDeLinkedin();
}

/* ================= What Lumen suggests next ================= */
// Not a sequence: experience, accreditations, strengthening and presenting feed each other, and the person
// can go back to any of them whenever they like. The agent proposes the one that would help most now.
function cycleCards() {
  const items = tray().items || [], pend = pendientes().length, nExp = evidences.length;
  const prog = acreditaciones.map((ac) => ({ ac, o: subjectOf(ac), p: leafProgress(ac) })).filter((x) => x.p.sts.length);
  const cerca = prog.filter((x) => x.p.pct < 100).sort((a, b) => b.p.pct - a.p.pct)[0], mejor = [...prog].sort((a, b) => b.p.pct - a.p.pct)[0];
  const enArbolIds = new Set(acreditaciones.flatMap((ac) => evsDe(ac.id).map((e) => e.id)));
  const flojas = evidences.filter((e) => scoresOf(e).suficiencia < 2).sort((a, b) => enArbolIds.has(b.id) - enArbolIds.has(a.id) || (a.fecha < b.fecha ? 1 : -1));
  const nuevasProp = nuevasLumen().filter((p) => !enArbol(p.asignatura_id)).length;
  const cards = [
    { k: "exp", icon: "◴", t: "Tu experiencia", m: nExp ? `${nExp} evidencia${nExp === 1 ? "" : "s"}${items.length ? ` · ${items.filter((x) => x.estado === "confirmada").length} de tu trayectoria` : ""}` : "Aún vacía",
      d: pend ? `Lumen encontró ${pend} experiencia${pend === 1 ? "" : "s"} que tienes que confirmar.` : "Documenta algo nuevo, súbelo al diario o carga tu currículum.",
      cta: pend ? `Revisar ${pend}` : nExp ? "Documentar algo" : "Cargar mi experiencia",
      go: () => (pend ? (show("trayectoria"), $("trayReview").scrollIntoView()) : nExp ? (show("agente") && !busy && (bubble("Quiero documentar algo nuevo.", "user"), begin())) : show("trayectoria")),
      chat: pend ? `Al buscar tu trayectoria encontré ${pend} experiencia${pend === 1 ? "" : "s"} que no sé seguro si ${pend === 1 ? "es tuya" : "son tuyas"}. ¿Las revisamos?` : "Cuéntame algo más que hayas hecho o aprendido, o sube tu currículum y tus títulos.",
      prio: pend ? 1 : nExp < 2 ? 2 : 9 },
    { k: "arbol", icon: "◎", t: "Tus acreditaciones", m: acreditaciones.length ? `${acreditaciones.length} en tu árbol` : "Ninguna todavía",
      d: nuevasProp ? `Lumen te propone ${nuevasProp} asignatura${nuevasProp === 1 ? "" : "s"} nueva${nuevasProp === 1 ? "" : "s"}.` : acreditaciones.length ? "Añade otra cuando quieras, de cualquier tema." : "Elige dónde puede contar lo que sabes.",
      cta: nuevasProp ? "Ver propuestas" : acreditaciones.length ? "Ver mi árbol" : "Elegir acreditación", go: () => show("arbol"),
      chat: !acreditaciones.length ? `Ya tienes ${nExp} evidencias. El siguiente paso es elegir dónde pueden contar: te propongo asignaturas reales de universidades.` : `Con lo que has documentado, te propongo ${nuevasProp} asignatura${nuevasProp === 1 ? "" : "s"} más para tu árbol.`,
      prio: !acreditaciones.length && nExp >= 2 ? 3 : nuevasProp ? 5 : 9 },
    { k: "reforzar", icon: "✎", t: "Reforzar evidencias", m: flojas.length ? `${flojas.length} con poco detalle` : "Todas con buen detalle",
      d: flojas.length ? `Por ejemplo, «${flojas[0].titulo}». Con 3 preguntas basta.` : cerca ? `En «${cerca.o.asignatura}» añade pruebas o la confirmación de alguien.` : "Añade pruebas y confirmaciones cuando las tengas.",
      cta: flojas.length ? "Reforzar una" : cerca ? "Ver qué falta" : "Mis evidencias",
      go: () => (flojas.length ? (show("evidencias"), openQuick(flojas[0].id)) : cerca ? openAcreditacion(cerca.ac.id, "ruta") : show("evidencias")),
      chat: flojas.length ? `${flojas.length === 1 ? "Una evidencia tiene" : `${flojas.length} evidencias tienen`} poco detalle, y así ${flojas.length === 1 ? "vale" : "valen"} menos ante una universidad. Empecemos por «${flojas[0].titulo}»: con 3 preguntas basta, o aportando su título o certificado si lo tiene.` : "",
      prio: flojas.length && acreditaciones.length ? 4 : 8 },
    { k: "presentar", icon: "◈", t: "Presentar", m: mejor ? `«${mejor.o.asignatura}» al ${mejor.p.pct} %` : "Sin acreditación aún",
      d: mejor ? (mejor.p.pct === 100 ? "Su expediente está listo para la universidad." : `${mejor.p.ready} de ${mejor.p.sts.length} resultados listos. Puedes descargar el expediente cuando quieras.`) : "Cuando tengas una acreditación, verás aquí su expediente.",
      cta: mejor ? "Ver expediente" : "Ver mi árbol", go: () => (mejor ? openAcreditacion(mejor.ac.id, "exp") : show("arbol")),
      chat: mejor ? (mejor.p.pct === 100 ? `«${mejor.o.asignatura}» está completa: su expediente está listo para presentarlo a la universidad.` : `«${mejor.o.asignatura}» va por el ${mejor.p.pct} %. Sigamos en su conversación con lo que le falta.`) : "",
      prio: mejor?.p.pct === 100 ? 1 : cerca ? 6 : 9 },
  ];
  const sug = [...cards].sort((a, b) => a.prio - b.prio)[0];
  if (sug.prio < 9) sug.sug = true;
  return cards;
}
const sugerencia = () => cycleCards().find((c) => c.sug) || null;
/** Lumen's proposal for now, said in the conversation with a button to do it. */
function proponer(saludo) {
  const sug = sugerencia();
  bubble(`${saludo}${sug ? `\n\n${sug.chat || sug.d}` : ""}\n\nO cuéntame directamente algo que hayas hecho o aprendido.`);
  stage = "start"; setPhase();
  choices([...(sug ? [sug.cta] : []), "Empezar a documentar", ...(acreditaciones.length ? [] : ["Quiero acreditar algo concreto"])]);
}

/* ================= Render ================= */
const CRIT_INFO = {
  validez: "Validez: si la evidencia se relaciona con resultados de aprendizaje concretos de la asignatura.",
  autenticidad: "Autenticidad: si se puede comprobar que es tuya (un producto que hiciste, un documento oficial o la confirmación de alguien).",
  suficiencia: "Suficiencia: si hay bastante detalle (qué aprendiste, un caso real, cómo lo aplicaste y sus límites).",
  vigencia: "Vigencia: qué reciente es. 3 = últimos 2 años, 2 = hasta 5, 1 = hasta 10, 0 = más de 10.",
};
/** The one thing that would most raise this evidence's assessment (currency last: it can't be fixed on the evidence itself). */
function mejoraTexto(e, s) {
  const orden = ["suficiencia", "autenticidad", "validez", "vigencia"].filter((k) => s[k] < 3).sort((a, b) => s[a] - s[b]);
  const k = orden.find((x) => x !== "vigencia") || orden[0];
  if (!k) return "Valoración máxima en los cuatro criterios.";
  const anos = Math.floor(yearsAgo(e.fecha));
  return {
    suficiencia: "Para mejorarla: añade detalle (un caso real, cómo lo aplicaste y qué límites tienes). Con «Completar con 3 preguntas» basta.",
    autenticidad: "Para mejorarla: adjunta algo que lo pruebe (un documento, un enlace o un certificado oficial) o pide la confirmación de alguien que lo vio.",
    validez: Object.keys(e.vinculos || {}).length ? "Para mejorarla: explica con más precisión qué aprendiste y cómo encaja con la asignatura." : "Para mejorarla: vincúlala a una acreditación de tu árbol, a resultados de aprendizaje concretos.",
    vigencia: `Es de hace ${anos} año${anos === 1 ? "" : "s"}: las universidades valoran más lo reciente. Si sigues aplicándolo, documenta un ejemplo actual.`,
  }[k];
}
function dots(v) { return `<span class="dots${v === 3 ? " complete" : ""}">${[1, 2, 3].map((i) => `<i class="${i <= v ? "on" : ""}"></i>`).join("")}</span>`; }
function render() {
  if (!perfil) return;
  if (vista === "acreditacion" && !acDe(acActual)) { show("arbol"); return; }
  renderMiniArbol(); renderArbol(); renderProposals(); renderTrayectoria();
  if (vista === "arbol") renderCatalog();
  if (vista === "evidencias") renderEvidenceList($("evidenceList"), evidences, NO_OBJ, true); else $("evidenceList").innerHTML = "";
  if (vista === "acreditacion") renderAcreditacion(); else $("acEvidenceList").innerHTML = "";
}
function kpisHtml(obj, evs) {
  const sts = obj.resultados.map((r) => outcomeStatus(r, evs)), ready = sts.filter((s) => s.n === 5).length, h = totalHours(evs), [e1, e2] = ectsRange(h);
  const verified = evs.filter((e) => e.verificacion?.estado === "confirmada").length, withArt = evs.filter((e) => (e.artefactos || []).length).length;
  return [
    [`${ready}/${sts.length}`, "Resultados listos para presentar"], [evs.length, "Evidencias registradas"], [fmtN(h) + " h", "Horas documentadas"],
    [h ? `${fmtN(e1)}–${fmtN(e2)}` : "0", `ECTS equivalentes${obj.ects ? " de " + obj.ects : ""} (25–30 h por crédito)`], [`${verified} · ${withArt}`, "Confirmadas por tercero · con producto"],
  ].map(([v, l]) => `<div class="stat"><strong>${safe(v)}</strong><small>${safe(l)}</small></div>`).join("");
}
function matrixHtml(obj, evs) {
  const ck = (b) => (b ? '<span class="yes">✓</span>' : '<span class="no">—</span>');
  return `<table><thead><tr><th>Resultado de aprendizaje</th><th>Evidencias</th><th>≥2</th><th>Producto</th><th>Tercero</th><th>Profundidad</th><th>Vigente</th><th>Horas</th><th>Estado</th></tr></thead><tbody>${obj.resultados.map((r) => { const s = outcomeStatus(r, evs); return `<tr><td><b>${safe(r.id)}</b> ${safe(r.texto)}</td><td class="c">${s.linked.length}</td><td class="c">${ck(s.checks.cantidad)}</td><td class="c">${ck(s.checks.producto)}</td><td class="c">${ck(s.checks.tercero)}</td><td class="c">${ck(s.checks.profundidad)}</td><td class="c">${ck(s.checks.vigente)}</td><td class="c">${fmtN(s.horas)}</td><td><span class="pill ${s.cls}">${s.label}</span></td></tr>`; }).join("")}</tbody></table>`;
}
/** Evidence cards. Inside an accreditation (acId) the outcome links are that accreditation's and can be edited;
    elsewhere each card shows which accreditations of the tree (acs) it counts for. */
function renderEvidenceList(container, evs, obj, editable, { acId = null, acs = acreditaciones } = {}) {
  const open = new Set([...container.querySelectorAll("details[open]")].map((d) => d.dataset.id));
  const rev = [...evs].reverse();
  if (!rev.length) { container.innerHTML = `<div class="empty">${editable ? "Aún no hay evidencias. Haz una entrevista o escribe en el diario rápido y aparecerán aquí con su valoración." : "Esta persona aún no tiene evidencias."}</div>`; return; }
  container.innerHTML = rev.map((e) => {
    const s = scoresOf(e), v = e.verificacion || {};
    const vPill = e.oficial ? `<span class="pill ok" title="${safe(e.oficial.tipo + " · " + e.oficial.emisor)}">🎓 Documento oficial</span>` : v.estado === "confirmada" ? '<span class="pill ok">Confirmada por tercero</span>' : v.estado === "solicitada" ? '<span class="pill warn">Confirmación solicitada</span>' : '<span class="pill">Sin confirmar</span>';
    const raTags = acId
      ? (e.resultados || []).map((id) => { const r = obj.resultados.find((x) => x.id === id); return `<span class="pill ra" title="${safe(r?.texto || "Este resultado ya no está en la asignatura")}">${safe(id)}</span>`; }).join("") || '<span class="pill">Sin resultado vinculado</span>'
      : acs.filter((ac) => e.vinculos?.[ac.id]?.length).map((ac) => `<button class="pill ra" type="button" data-ac="${safe(ac.id)}" title="${safe(e.vinculos[ac.id].join(", "))}">◎ ${safe(subjectOf(ac).asignatura)}</button>`).join("") || `<span class="pill">${acs.length ? "Todavía no cuenta para ninguna acreditación" : "Sin acreditación"}</span>`;
    const texts = Object.entries(e.evidencias || {}).map(([k, t]) => `<p><strong>${safe(EV_LABELS[k] || k)}:</strong> ${safe(t)}</p>`).join("");
    const mat = (e.material ? `<button class="pill" data-act="open" data-path="${safe(e.material.path)}" title="Contenido del que aprendió">📄 ${safe(e.material.name)}</button>` : "")
      + (e.contexto_web?.path ? `<button class="pill" data-act="open" data-path="${safe(e.contexto_web.path)}" title="Información buscada en internet durante la entrevista">🔎 Contexto de internet</button>` : "");
    const arts = mat + (e.artefactos || []).map((a) => a.url
      ? `<a class="pill" href="${safe(a.url)}" target="_blank" rel="noopener">🔗 ${safe(a.name)}</a>`
      : `<button class="pill" data-act="open" data-path="${safe(a.path)}">${a.origen === "drive" ? "🗂" : a.origen === "cv" ? "📄" : "📎"} ${safe(a.name)}</button>`).join("");
    const lecturas = (e.artefactos || []).filter((a) => a.lectura).map((a) => a.lectura.error
      ? `<li><b>${safe(a.name)}:</b> Lumen no pudo leerlo. ${safe(a.lectura.error)}</li>`
      : `<li><b>${safe(a.name)}:</b> ${a.lectura.oficial ? `<span class="pill ${a.lectura.oficial.coincide_titular === "no" ? "warn" : "ok"}">🎓 ${safe(a.lectura.oficial.tipo)} · ${safe(a.lectura.oficial.emisor)}${a.lectura.oficial.titular ? " · a nombre de " + safe(a.lectura.oficial.titular) : ""}${a.lectura.oficial.coincide_titular === "no" ? " · no coincide contigo" : ""}</span> ` : ""}${safe(a.lectura.que_es)}${a.lectura.resultados?.length ? ` Respalda ${safe(a.lectura.resultados.join(", "))}.` : ""} <span class="subtle">Autoría: ${safe(a.lectura.autoria)}${a.lectura.notas ? " · " + safe(a.lectura.notas) : ""}</span></li>`).join("");
    const verif = !editable && v.nombre ? `<p><strong>Confirmación:</strong> ${safe(v.nombre)}${v.rol ? " (" + safe(v.rol) + ")" : ""}${v.contacto ? " · " + safe(v.contacto) : ""} · ${safe(v.estado)}</p>` : "";
    const id = safe(e.id);
    return `<article class="card">
      <div class="card-head"><div style="min-width:0"><b>${safe(e.titulo)}</b><small>${e.tipo === "diario" ? "Diario" : e.tipo === "trayectoria" ? "Trayectoria" : e.tipo === "documento" ? "Documento oficial" : "Entrevista"} · ${safe(fmtDate(e.fecha))}${e.contexto ? " · " + safe(e.contexto) : ""}${e.horas ? " · " + fmtN(num(e.horas)) + " h" : ""}</small></div>${vPill}</div>
      <div class="chips">${raTags}${arts}</div>
      ${lecturas ? `<ul class="lecturas"><li class="subtle">Revisión de las pruebas por Lumen</li>${lecturas}</ul>` : ""}
      ${oficialValido(e) ? `<div class="oficial-box"><b>🎓 Acreditado con documento oficial</b><span>${safe(e.oficial.tipo)} · ${safe(e.oficial.emisor)}${e.oficial.fecha ? " · " + safe(fmtDate(e.oficial.fecha)) : ""}${e.oficial.codigo ? ` · código de verificación <code>${safe(e.oficial.codigo)}</code>` : ""}</span><small class="subtle">No hace falta valorarlo con criterios: el documento oficial ya prueba el aprendizaje. Solo queda vincularlo a las acreditaciones donde cuente.</small></div>` : `<div class="vasc" title="Cómo valoraría una universidad esta evidencia">${CRIT.map(([k, l]) => `<div title="${safe(CRIT_INFO[k])}">${l} ${s[k]}/3${dots(s[k])}</div>`).join("")}</div>
      ${editable ? `<p class="vasc-help"><b>Cómo la valoraría una universidad (de 0 a 3).</b> ${safe(mejoraTexto(e, s))}</p>` : ""}`}
      ${e.falta ? `<div class="falta">Le falta: ${safe(e.falta)}</div>` : ""}
      ${editable && !quickState[e.id] && (s.suficiencia < 2 || !e.oficial) ? `<div class="row-actions" style="margin-top:8px">
        ${e.oficial ? "" : `<label class="btn small${esFormacion(e) ? " accent" : ""}" for="cert-${id}">🎓 ${safe(certLabel(e))}</label><input type="file" id="cert-${id}" data-act="upload" data-clase="acreditativo" data-id="${id}" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" class="visually-hidden">`}
        ${s.suficiencia < 2 ? `<button class="btn small${esFormacion(e) && !e.oficial ? "" : " accent"}" data-act="quick" data-id="${id}">Completar con 3 preguntas</button>` : ""}
        <span class="toast" id="cmsg-${id}" aria-live="polite"></span></div>` : ""}
      ${editable ? quickHtml(e) : ""}
      <details class="more" data-id="${id}"${open.has(e.id) ? " open" : ""}>
        <summary>${editable ? "Contenido, pruebas y confirmación" : "Contenido"}</summary>
        ${texts}${verif}
        ${editable ? `
        <div class="edit-grid">
          <label class="field">Título<input id="t-${id}" value="${safe(e.titulo)}"></label>
          <label class="field">Fecha<input type="date" id="f-${id}" value="${safe(e.fecha)}"></label>
          <label class="field">Horas dedicadas<input type="number" min="0" step="0.5" id="h-${id}" value="${safe(e.horas || 0)}"></label>
          <label class="field">Contexto<select id="c-${id}">${["", ...CONTEXTOS].map((o) => `<option${o === e.contexto ? " selected" : ""}>${o}</option>`).join("")}</select></label>
        </div>
        ${acId ? `<div class="field" style="margin-top:10px">Resultados de aprendizaje de esta acreditación que respalda
          <div class="chips">${obj.resultados.map((r) => `<label class="pill ra" title="${safe(r.texto)}"><input type="checkbox" data-ra="${safe(r.id)}" data-ev="${id}"${(e.resultados || []).includes(r.id) ? " checked" : ""}> ${safe(r.id)}</label>`).join("")}</div>
        </div>` : ""}
        <div class="edit-grid">
          <label class="field">Quién puede confirmarlo<input id="vn-${id}" value="${safe(v.nombre)}" placeholder="Nombre y apellidos"></label>
          <label class="field">Rol o relación<input id="vr-${id}" value="${safe(v.rol)}" placeholder="Ej.: responsable de equipo"></label>
          <label class="field">Contacto<input id="vc-${id}" value="${safe(v.contacto)}" placeholder="Correo o teléfono"></label>
          <label class="field">Estado de la confirmación<select id="vs-${id}">${["sin solicitar", "solicitada", "confirmada"].map((o) => `<option${o === v.estado ? " selected" : ""}>${o}</option>`).join("")}</select></label>
        </div>
        <div class="row-actions">
          <button class="btn small accent" data-act="save" data-id="${id}">Guardar cambios</button>
          <button class="btn small" data-act="copy" data-id="${id}">Copiar solicitud de confirmación</button>
          <label class="btn small" for="up-${id}">📎 Adjuntar archivo</label>
          <input type="file" id="up-${id}" data-act="upload" data-id="${id}" style="position:absolute;width:1px;height:1px;opacity:0">
          <button class="btn small" data-act="link" data-id="${id}">🔗 Añadir enlace</button>
          ${googleCfg ? `<button class="btn small" data-act="drive" data-id="${id}">🗂 Google Drive</button>` : ""}
          <button class="btn small danger" data-act="del" data-id="${id}">Eliminar</button>
          <span class="toast" id="msg-${id}"></span>
        </div>
        <div class="row-actions" id="lk-${id}" hidden>
          <input class="link-input" id="lkurl-${id}" type="url" placeholder="https://… (web, GitHub, documento publicado, PDF)" aria-label="Enlace a la prueba">
          <button class="btn small accent" data-act="addlink" data-id="${id}">Añadir</button>
        </div>
        <textarea class="copybox field" id="cb-${id}" hidden readonly></textarea>` : ""}
      </details>
    </article>`;
  }).join("");
}
function verificationText(e) {
  const v = e.verificacion || {}, ras = (e.resultados || []).map((id) => objetivo.resultados.find((r) => r.id === id)?.texto).filter(Boolean);
  return `Hola${v.nombre ? " " + v.nombre : ""}:

Estoy preparando un expediente para solicitar el reconocimiento académico de aprendizajes adquiridos por experiencia${objetivo.titulacion ? " en " + objetivo.titulacion : ""}${objetivo.universidad ? " (" + objetivo.universidad + ")" : ""}.

¿Podrías confirmar, por escrito y con tu nombre, cargo y fecha, que realicé esta actividad?

· Actividad: ${e.titulo}
· Fecha aproximada: ${fmtDate(e.fecha)}${e.horas ? "\n· Dedicación aproximada: " + fmtN(num(e.horas)) + " horas" : ""}${e.contexto ? "\n· Contexto: " + e.contexto : ""}${ras.length ? "\n· Lo que demuestra: " + ras.join(" / ") : ""}

Basta con que respondas a este mensaje indicando si es correcto y, si quieres, añadas tu valoración. Muchas gracias.

${perfil.nombre || ""}`;
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest('[data-act="open"]');
  if (b) openFile(b.dataset.path);
});
const acOfList = (el) => (el.id === "acEvidenceList" ? acActual : null);
async function onEvidenceClick(ev) {
  const b = ev.target.closest("button[data-act]"); if (!b || b.dataset.act === "open") return;
  const e = evidences.find((x) => x.id === b.dataset.id); if (!e) return;
  const acId = acOfList(ev.currentTarget);
  const msg = () => $("msg-" + e.id), say = (t) => { const m = msg(); if (m) m.textContent = t; };
  if (b.dataset.act === "quick") { openQuick(e.id, acId); return; }
  if (b.dataset.act === "quickcancel") { delete quickState[e.id]; render(); return; }
  if (b.dataset.act === "quicksave") { saveQuick(e); return; }
  if (b.dataset.act === "save") {
    const n = structuredClone(e);
    n.titulo = $("t-" + e.id).value.trim() || e.titulo; n.fecha = $("f-" + e.id).value || e.fecha; n.horas = num($("h-" + e.id).value); n.contexto = $("c-" + e.id).value;
    if (acId) n.vinculos = { ...(n.vinculos || {}), [acId]: [...document.querySelectorAll(`input[data-ev="${e.id}"]`)].filter((c) => c.checked).map((c) => c.dataset.ra) };
    n.verificacion = { nombre: $("vn-" + e.id).value.trim(), rol: $("vr-" + e.id).value.trim(), contacto: $("vc-" + e.id).value.trim(), estado: $("vs-" + e.id).value };
    try { await saveEvidence(n); say("Guardado"); } catch (err) { say(err.message); }
  }
  if (b.dataset.act === "link") { const row = $("lk-" + e.id); row.hidden = !row.hidden; if (!row.hidden) $("lkurl-" + e.id).focus(); return; }
  if (b.dataset.act === "addlink") {
    const url = $("lkurl-" + e.id).value.trim();
    if (!/^https?:\/\/\S+\.\S+/.test(url)) { msg().textContent = "Escribe un enlace completo, que empiece por https://"; return; }
    let name = url; try { const u = new URL(url); name = u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, ""); } catch {}
    $("lk-" + e.id).hidden = true;
    await addArtefact(e.id, { name: name.slice(0, 120), url, origen: "enlace", subidoEl: new Date().toISOString() });
    return;
  }
  if (b.dataset.act === "drive") {
    b.disabled = true;
    try {
      const files = await pickDriveFiles({ multiple: true });
      for (const f of files) { msg().textContent = `Copiando «${f.name}» desde Drive…`; await addArtefact(e.id, { ...(await uploadFile(f, e.id)), origen: "drive" }); }
    } catch (err) { msg().textContent = err.message; }
    finally { b.disabled = false; }
    return;
  }
  if (b.dataset.act === "copy") {
    const t = verificationText(e);
    navigator.clipboard.writeText(t).then(() => say("Copiada. Envíala por correo y adjunta la respuesta como prueba.")).catch(() => { const cb = $("cb-" + e.id); cb.hidden = false; cb.value = t; cb.select(); say("Selecciona el texto y cópialo."); });
  }
  if (b.dataset.act === "del") {
    if (b.dataset.armed) { try { await deleteEvidence(e); } catch (err) { say(err.message); } return; }
    b.dataset.armed = "1"; b.textContent = acreditaciones.length > 1 ? "Pulsa otra vez: se elimina de todas tus acreditaciones" : "Pulsa otra vez para eliminar";
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Eliminar"; } }, 4000);
  }
}
async function onEvidenceChange(ev) {
  const inp = ev.target.closest('input[data-act="upload"]'); if (!inp) return;
  const f = inp.files?.[0], e = evidences.find((x) => x.id === inp.dataset.id); if (!f || !e) return;
  const clase = inp.dataset.clase || "";
  const say = (t) => { const m = $((clase ? "cmsg-" : "msg-") + e.id); if (m) m.textContent = t; };
  say(clase ? "Subiendo el documento…" : "Subiendo…");
  try { await addArtefact(e.id, { ...(await uploadFile(f, e.id)), ...(clase ? { clase } : {}) }, say); } catch (err) { say(err.message); }
}
function onEvidenceInput(ev) {
  const el = ev.target.closest("[data-quick]"); if (!el) return;
  const q = quickState[el.dataset.quick]; if (!q) return;
  if (el.dataset.i === "horas") q.horas = el.value; else q.respuestas[Number(el.dataset.i)] = el.value;
}
for (const list of [$("evidenceList"), $("acEvidenceList")]) {
  list.addEventListener("click", onEvidenceClick);
  list.addEventListener("change", onEvidenceChange);
  list.addEventListener("input", onEvidenceInput);
}
/** Saves a proof on an evidence and asks Lumen to review it against the official learning outcomes. */
async function addArtefact(evId, a, sayFn) {
  const say = (t) => { if (sayFn) return sayFn(t); const m = $("msg-" + evId); if (m) m.textContent = t; };
  let e = evidences.find((x) => x.id === evId);
  await saveEvidence({ ...structuredClone(e), artefactos: [...(e.artefactos || []), a] });
  say("Prueba añadida. Lumen la está revisando…");
  const lectura = await reviewArtefactAI(e, a);
  e = evidences.find((x) => x.id === evId);
  if (!e || !lectura) { say("Prueba añadida."); return; }
  const n = { ...structuredClone(e), artefactos: (e.artefactos || []).map((x) => (x.path === a.path && x.url === a.url && x.name === a.name ? { ...x, lectura } : x)) };
  const o = lectura.oficial;
  if (o && !e.oficial) conOficial(n, o);
  await saveEvidence(n);
  if (o && o.coincide_titular !== "no") vincularEnArbol(n);
  say(lectura.error ? "Prueba añadida (Lumen no pudo leerla)."
    : o?.coincide_titular === "no" ? `Lumen ha leído el documento, pero está a nombre de ${o.titular}. Comprueba que es el tuyo.`
    : o ? `Documento oficial verificado: ${o.tipo} de ${o.emisor}.`
    : a.clase ? "Lumen no lo reconoce como un documento oficial (título, certificado…). Queda guardado como prueba." : "Prueba añadida y revisada.");
}
/* ---------- Titles and certificates the person already has ---------- */
const CONTEXTO_DOC = { "Certificado de empresa": "Trabajo", "Vida laboral": "Trabajo", "Certificado de voluntariado": "Voluntariado", "Título o certificado de formación": "Formación no reglada", "Certificado de idiomas": "Formación no reglada" };
/** An existing evidence about the same thing (e.g. found in the track record), so the document completes it instead of duplicating it. */
function evidenciaParecida(titulo) {
  const w = new Set(concepts(titulo, 12));
  if (!w.size) return null;
  let best = null, bestN = 0;
  for (const e of evidences) {
    const n = concepts(e.titulo, 12).filter((x) => w.has(x)).length;
    if (n > bestN) { best = e; bestN = n; }
  }
  return bestN >= 2 || (bestN === 1 && w.size <= 2) ? best : null;
}
let subiendoCerts = false;
async function subirCertificados(files) {
  if (subiendoCerts || !files.length) return;
  const log = $("certLog"); log.hidden = false;
  if (!aiOk) { log.innerHTML = '<li class="warn">La IA no está disponible ahora mismo: inténtalo en unos minutos.</li>'; return; }
  subiendoCerts = true;
  const linea = (f) => { const li = document.createElement("li"); li.textContent = `${f.name}: leyendo…`; log.prepend(li); return li; };
  for (const f of [...files].slice(0, 15)) {
    const li = linea(f), id = uid();
    try {
      if (!/\.(pdf|png|jpe?g|webp)$/i.test(f.name) && !/^image\//.test(f.type)) throw new Error("sube el documento en PDF o como foto.");
      const a = { ...(await uploadFile(f, id, "certificados")), clase: "acreditativo" };
      const lectura = await (await api("/api/artefacto", { path: a.path, nombre: f.name, evidencia: { titulo: f.name, resumen: "Documento que la persona aporta como título o certificado de lo que ya sabe." } })).json();
      const o = lectura.oficial;
      if (!o) { await sb.storage.from(BUCKET).remove([a.path]); li.className = "warn"; li.textContent = `${f.name}: no parece un título ni un certificado oficial (${String(lectura.que_es || "").replace(/\.\s*$/, "")}). No lo he guardado; si es una prueba de algo que hiciste, adjúntalo a esa evidencia.`; continue; }
      if (o.coincide_titular === "no") { await sb.storage.from(BUCKET).remove([a.path]); li.className = "warn"; li.textContent = `${f.name}: está a nombre de ${o.titular}, no al tuyo. No lo he guardado.`; continue; }
      const art = { ...a, lectura };
      const previa = evidenciaParecida(o.titulo_acreditado || "");
      let n;
      if (previa?.oficial) {
        n = { ...structuredClone(previa), artefactos: [...(previa.artefactos || []), art] };
        li.textContent = `${f.name}: ✓ ${o.tipo} de ${o.emisor}. «${previa.titulo}» ya estaba acreditada; he añadido este documento a sus pruebas.`;
      } else if (previa) {
        n = conOficial({ ...structuredClone(previa), artefactos: [...(previa.artefactos || []), art] }, o);
        li.textContent = `${f.name}: ✓ ${o.tipo} de ${o.emisor}. Lo he añadido a tu evidencia «${previa.titulo}», que ya queda acreditada.`;
      } else {
        n = conOficial({
          id, kind: "evidence", tipo: "documento", titulo: o.titulo_acreditado || o.tipo, fuente: "Formación", url: "", fecha: o.fecha || today(), createdAt: Date.now(),
          contexto: CONTEXTO_DOC[o.tipo] || "", horas: 0, resultados: [], evidencias: { texto: lectura.que_es },
          criterios: { validez: 2, suficiencia: 2 }, falta: "", artefactos: [art],
          verificacion: { nombre: "", rol: "", contacto: "", estado: "sin solicitar" }, dialogue: [], ai: true,
        }, o);
        li.textContent = `${f.name}: ✓ ${o.tipo} de ${o.emisor}. Creada la evidencia «${n.titulo}».`;
      }
      li.className = "ok";
      await saveEvidence(n);
      vincularEnArbol(n);
    } catch (e) { aiProblem(e); li.className = "warn"; li.textContent = `${f.name}: ${e.message}`; }
  }
  subiendoCerts = false;
  maybeAutoPropose();
}
$("certFiles").addEventListener("change", (ev) => { const fs = [...(ev.target.files || [])]; ev.target.value = ""; subirCertificados(fs); });
for (const type of ["dragover", "dragleave", "drop"]) $("certDrop").addEventListener(type, (ev) => {
  ev.preventDefault(); $("certDrop").classList.toggle("over", type === "dragover");
  if (type === "drop" && ev.dataTransfer?.files?.length) subirCertificados([...ev.dataTransfer.files]);
});

/** Formal learning is proved by its official document: what it accredits feeds the evidence. */
const esFormacion = (e) => e.fuente === "Formación" || /formaci|curso|grado|m[aá]ster|t[ií]tulo|certific|diploma|licenciatura|doctorado|bootcamp/i.test(`${e.titulo} ${e.contexto}`);
function certLabel(e) {
  if (esFormacion(e)) return "Aportar título o certificado";
  if (e.contexto === "Trabajo") return "Aportar certificado de empresa o vida laboral";
  if (e.contexto === "Voluntariado") return "Aportar certificado de voluntariado";
  return "Aportar documento oficial";
}
function conOficial(n, o) {
  if (o.coincide_titular === "no") { n.falta = `El documento aportado está a nombre de ${o.titular}. Si es tuyo, revisa el nombre de tu cuenta; si no, aporta el tuyo.`; return n; }
  n.oficial = { tipo: o.tipo, emisor: o.emisor, fecha: o.fecha, horas: o.horas, ects: o.ects, codigo: o.codigo_verificacion || "" };
  // Course-sized documents give the hours; a whole degree would swamp a single subject's workload, so it doesn't.
  if (!num(n.horas)) n.horas = o.horas && o.horas <= 750 ? o.horas : o.ects && o.ects <= 30 ? o.ects * HOURS_PER_ECTS_MIN : 0;
  if (o.fecha && n.tipo === "trayectoria") n.fecha = o.fecha;
  if (o.contenidos?.length) n.evidencias = { ...(n.evidencias || {}), contenidos: o.contenidos.join("; ") };
  n.criterios = { validez: Math.max(2, clamp03(n.criterios?.validez)), suficiencia: Math.max(2, clamp03(n.criterios?.suficiencia)) };
  if (n.verificacion?.estado !== "confirmada") n.verificacion = { ...(n.verificacion || {}), nombre: o.emisor, rol: `Entidad que expide el documento oficial (${o.tipo.toLowerCase()})`, estado: "confirmada" };
  n.falta = /universitario|académico/i.test(o.tipo) && !o.contenidos?.length
    ? "Para que cuente en asignaturas concretas, aporta también el certificado académico con las asignaturas cursadas, o cuenta con 3 preguntas qué aprendiste y cómo lo aplicas."
    : "";
  return n;
}
async function reviewArtefactAI(e, a) {
  if (!aiOk) return null;
  try {
    return await (await api("/api/artefacto", { acreditacion_id: vista === "acreditacion" ? acActual : null, path: a.path || "", url: a.url || "", nombre: a.name, evidencia: { titulo: e.titulo, resumen: Object.values(e.evidencias || {}).join(" ") } })).json();
  } catch (err) {
    if (err.status === 415 || err.status === 413 || err.status === 422 || err.status === 504) return { error: err.message };
    aiProblem(err); return null;
  }
}

/* ================= Coordination ================= */
let people = [], selected = null, peopleAcs = [];
async function loadPeople() {
  const { data, error } = await sb.from("perfiles").select("*").neq("user_id", session.user.id).eq("compartir_con_coordinacion", true).order("nombre");
  if (error) { $("people").innerHTML = '<div class="empty">No se pudo cargar la lista.</div>'; return; }
  people = data;
  const r = people.length ? await sb.from("acreditaciones").select("user_id,asignatura_id").in("user_id", people.map((p) => p.user_id)) : { data: [] };
  peopleAcs = r.data || [];
  const resumen = (p) => { const acs = peopleAcs.filter((a) => a.user_id === p.user_id); return acs.length ? acs.map((a) => subjectOf(a).asignatura).join(" · ") : targetName(resolveObjetivo(p.objetivo)); };
  $("people").innerHTML = people.length ? people.map((p) => `<button class="person${selected?.user_id === p.user_id ? " on" : ""}" data-person="${safe(p.user_id)}"><span class="person-who">${p.avatar ? `<img class="avatar small img" src="${safe(p.avatar)}" alt="">` : ""}<span><b>${safe(p.nombre || "Sin nombre")}</b><br><small class="subtle">${safe([p.ficha?.titular, resumen(p)].filter(Boolean).join(" · "))}</small></span></span><span>→</span></button>`).join("") : '<div class="empty">Todavía nadie ha compartido su expediente.</div>';
}
$("people").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-person]"); if (!b) return;
  const p = people.find((x) => x.user_id === b.dataset.person); if (!p) return;
  const [r1, r2] = await Promise.all([sb.from("evidencias").select("data,created_at").eq("user_id", p.user_id).order("created_at"), sb.from("acreditaciones").select("*").eq("user_id", p.user_id).order("created_at")]);
  if (r1.error) return;
  const evs = r1.data.map((r) => r.data);
  let acs = r2.data || [];
  // Participants who have not signed in since the tree arrived still have a single target in their profile.
  if (!acs.length && p.objetivo?.asignatura_id) acs = [{ id: "legado", asignatura_id: p.objetivo.asignatura_id }];
  selected = { ...p, evs, acs: acs.map((ac) => ({ ac, o: ac.id === "legado" ? resolveObjetivo(p.objetivo) : subjectOf(ac), evs: ac.id === "legado" ? evs : evsDe(ac.id, evs) })) };
  document.querySelectorAll(".person").forEach((x) => x.classList.toggle("on", x === b));
  $("coordDetail").hidden = false;
  $("coordName").textContent = p.nombre || "Sin nombre";
  $("coordAcs").innerHTML = selected.acs.length ? selected.acs.map(({ ac, o, evs: e2 }) => `<section class="coord-ac">
      <h3>${safe(o.asignatura)}</h3><p class="note">${safe(o.titulacion)} · ${safe(o.universidad)} ${convenioPill(o.estado)}</p>
      ${progressHtml(o, e2)}<div class="kpis">${kpisHtml(o, e2)}</div><div class="matrix">${matrixHtml(o, e2)}</div>
      <div class="row-actions"><button class="btn primary small" data-coordexp="${safe(ac.id)}">↓ Descargar este expediente (HTML)</button></div></section>`).join("")
    : '<div class="empty">Esta persona aún no tiene acreditaciones en su árbol.</div>';
  renderEvidenceList($("coordEvidences"), evs, NO_OBJ, false, { acs: selected.acs.filter((x) => x.ac.id !== "legado").map((x) => x.ac) });
  $("coordDetail").scrollIntoView({ behavior: "smooth" });
});
$("coordAcs").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-coordexp]"); if (!b || !selected) return;
  const x = selected.acs.find((a) => a.ac.id === b.dataset.coordexp); if (!x) return;
  download(`lumen-expediente-${normalize(selected.nombre || "participante").replace(/\W+/g, "-")}-${normalize(x.o.asignatura).replace(/\W+/g, "-")}.html`, dossierHtml(x.o, x.evs, selected.nombre), "text/html");
});

/* ================= Coordination: official catalog ================= */
let solicitudes = [];
async function loadCoordCatalog() {
  if (perfil.role !== "coordinador") return;
  const [, r] = await Promise.all([loadCatalog(), sb.from("solicitudes_catalogo").select("*").order("created_at", { ascending: false })]);
  solicitudes = r.data || [];
  renderCoordCatalog();
}
function renderCoordCatalog() {
  const label = { publicada: ["ok", "Con convenio"], detectada: ["warn", "Detectada, sin convenio"], borrador: ["", "Borrador"], retirada: ["", "Retirada"] };
  $("catAdmin").innerHTML = catalogo.length ? catalogo.map((a) => `<div class="cat-row"><div style="min-width:0"><b>${safe(a.asignatura)}</b><small>${safe(a.titulacion)} · ${safe(a.universidad)} · ${fmtN(Number(a.ects))} ECTS · ${a.resultados.length} RA · <a href="${safe(a.fuente_url)}" target="_blank" rel="noopener">fuente</a></small></div>
    <div class="row-actions" style="margin-top:0"><span class="pill ${label[a.estado][0]}">${label[a.estado][1]}</span><button class="btn small" data-cat="edit" data-id="${safe(a.id)}">Editar</button>${a.estado === "publicada" ? `<button class="btn small" data-cat="retirada" data-id="${safe(a.id)}">Retirar</button>` : `<button class="btn small accent" data-cat="publicada" data-id="${safe(a.id)}">${a.estado === "detectada" ? "Firmado: marcar con convenio" : "Publicar con convenio"}</button>${a.estado === "detectada" ? `<button class="btn small" data-cat="retirada" data-id="${safe(a.id)}">Retirar</button>` : ""}`}</div></div>`).join("")
    : '<div class="empty">El catálogo está vacío. Añade la primera asignatura con la URL de su guía docente.</div>';
  const pend = solicitudes.filter((x) => x.estado === "pendiente");
  $("reqList").innerHTML = pend.length ? pend.map((x) => `<div class="cat-row"><div style="min-width:0"><b>${safe(x.texto)}</b><small>${safe(fmtDate(x.created_at.slice(0, 10)))}${x.url ? ` · <a href="${safe(x.url)}" target="_blank" rel="noopener">guía propuesta</a>` : ""}</small></div>
    <div class="row-actions" style="margin-top:0">${x.url ? `<button class="btn small" data-req="usar" data-id="${safe(x.id)}">Leer su guía</button>` : ""}<button class="btn small" data-req="añadida" data-id="${safe(x.id)}">Marcar como añadida</button><button class="btn small" data-req="descartada" data-id="${safe(x.id)}">Descartar</button></div></div>`).join("")
    : '<div class="empty">No hay solicitudes pendientes.</div>';
}
let editingId = null;
function fillSubjectForm(d, id = null) {
  editingId = id;
  $("subjectForm").hidden = false;
  $("sUni").value = d.universidad || ""; $("sTit").value = d.titulacion || ""; $("sRuct").value = d.codigo_ruct || "";
  $("sNivel").value = ["Grado", "Máster", "Microcredencial", "Título propio"].includes(d.nivel) ? d.nivel : "Grado";
  $("sAsig").value = d.asignatura || ""; $("sCod").value = d.codigo_asignatura || ""; $("sCurso").value = d.curso_academico || "";
  $("sEcts").value = d.ects || ""; $("sCar").value = d.caracter || "";
  $("sRA").value = (d.resultados || []).map((r) => (typeof r === "string" ? r : r.texto)).join("\n");
  $("sFuente").value = d.fuente_url || "";
  $("sAviso").hidden = !d.aviso; $("sAviso").textContent = d.aviso || "";
  $("sMsg").textContent = "";
  $("subjectForm").scrollIntoView({ behavior: "smooth" });
}
$("guideForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("gRead"); btn.disabled = true; btn.textContent = "Leyendo la guía…"; $("gMsg").textContent = "";
  try {
    const d = await (await api("/api/catalogo", { url: $("gUrl").value.trim(), texto: $("gText").value.trim() })).json();
    if (!d.resultados.length) d.aviso = (d.aviso ? d.aviso + " " : "") + "No he encontrado resultados de aprendizaje: cópialos de la guía.";
    fillSubjectForm(d);
    $("gMsg").textContent = "Revisa cada campo con la guía antes de publicar.";
  } catch (e) { $("gMsg").textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = "Leer guía docente"; }
});
$("sCancel").onclick = () => { $("subjectForm").hidden = true; editingId = null; };
$("subjectForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const estado = ev.submitter?.dataset.estado || "borrador";
  const lines = $("sRA").value.split("\n").map((t) => t.trim()).filter(Boolean);
  if (!lines.length) { $("sMsg").textContent = "Añade al menos un resultado de aprendizaje."; return; }
  const row = {
    universidad: $("sUni").value.trim(), titulacion: $("sTit").value.trim(), codigo_ruct: $("sRuct").value.trim(), nivel: $("sNivel").value,
    asignatura: $("sAsig").value.trim(), codigo_asignatura: $("sCod").value.trim(), curso_academico: $("sCurso").value.trim(),
    ects: num($("sEcts").value), caracter: $("sCar").value.trim(), resultados: lines.map((t, i) => ({ id: "RA" + (i + 1), texto: t })),
    fuente_url: $("sFuente").value.trim(), estado,
    ...(estado === "publicada" ? { revisado_por: session.user.id, revisado_at: new Date().toISOString() } : {}),
  };
  const { error } = editingId ? await sb.from("catalogo_asignaturas").update(row).eq("id", editingId) : await sb.from("catalogo_asignaturas").insert(row);
  if (error) { $("sMsg").textContent = "No se pudo guardar: revisa que no falte ningún campo obligatorio."; return; }
  $("subjectForm").hidden = true; editingId = null; $("gUrl").value = ""; $("gText").value = "";
  $("gMsg").textContent = estado === "publicada" ? "Publicada en el catálogo." : "Guardada como borrador.";
  await loadCoordCatalog();
});
$("catAdmin").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-cat]"); if (!b) return;
  const a = catalogo.find((x) => x.id === b.dataset.id); if (!a) return;
  if (b.dataset.cat === "edit") { fillSubjectForm(a, a.id); return; }
  b.disabled = true;
  const patch = b.dataset.cat === "publicada" ? { estado: "publicada", revisado_por: session.user.id, revisado_at: new Date().toISOString() } : { estado: b.dataset.cat };
  await sb.from("catalogo_asignaturas").update(patch).eq("id", a.id);
  await loadCoordCatalog();
});
$("reqList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-req]"); if (!b) return;
  const x = solicitudes.find((r) => r.id === b.dataset.id); if (!x) return;
  if (b.dataset.req === "usar") { $("gUrl").value = x.url; $("guideForm").scrollIntoView({ behavior: "smooth" }); return; }
  b.disabled = true;
  await sb.from("solicitudes_catalogo").update({ estado: b.dataset.req }).eq("id", x.id);
  await loadCoordCatalog();
});

/* ================= Account ================= */
/* ================= My profile ================= */
const iniciales = () => (perfil.nombre || session.user.email).split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
function pintarAvatar(el) {
  if (perfil.avatar) { el.innerHTML = ""; const img = new Image(); img.src = perfil.avatar; img.alt = ""; el.append(img); el.classList.add("img"); }
  else { el.textContent = iniciales(); el.classList.remove("img"); }
}
const ficha = () => perfil.ficha || {};
function fillPerfil() {
  const f = ficha();
  $("aName").value = perfil.nombre || ""; $("aShare").checked = !!perfil.compartir_con_coordinacion;
  $("aTitular").value = f.titular || ""; $("aLugar").value = f.lugar || ""; $("aLinkedin").value = f.linkedin_url || ""; $("aWeb").value = f.web || ""; $("aSobre").value = f.sobre || "";
  renderPerfil();
  comprobarLinkedin();
}
function renderPerfil() {
  pintarAvatar($("pAvatar")); pintarAvatar($("avatar"));
  $("pQuitarFoto").hidden = !perfil.avatar;
  const f = ficha(), horas = totalHours(evidences), oficiales = evidences.filter((e) => e.oficial).length;
  const mejor = acreditaciones.map((ac) => ({ o: subjectOf(ac), p: leafProgress(ac) })).sort((a, b) => b.p.pct - a.p.pct)[0];
  $("profileHead").innerHTML = `<div class="profile-top"><div class="avatar big" id="phAvatar"></div>
      <div style="min-width:0"><h2 style="margin:0">${safe(perfil.nombre || "Sin nombre")}</h2>
        <p class="subtle" style="margin:4px 0 0;font-size:14px">${safe([f.titular, f.lugar].filter(Boolean).join(" · ") || "Añade a qué te dedicas y dónde, más abajo.")}</p>
        <div class="chips" style="margin-top:8px">${f.linkedin_url ? `<a class="pill" href="${safe(f.linkedin_url)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ""}${f.web ? `<a class="pill" href="${safe(f.web)}" target="_blank" rel="noopener">Web ↗</a>` : ""}${f.linkedin?.conectado ? '<span class="pill ok">Conectado con LinkedIn</span>' : ""}</div></div></div>
    ${f.sobre ? `<p style="margin:14px 0 0;max-width:760px">${safe(f.sobre)}</p>` : ""}
    <div class="kpis" style="margin-top:16px">${[[evidences.length, "Evidencias"], [oficiales, "Con documento oficial"], [fmtN(horas) + " h", "Horas documentadas"], [acreditaciones.length, "Acreditaciones en tu árbol"], [mejor ? mejor.p.pct + " %" : "—", mejor ? "Avance de «" + mejor.o.asignatura + "»" : "Tu acreditación más avanzada"]].map(([v, l]) => `<div class="stat"><strong>${safe(v)}</strong><small>${safe(l)}</small></div>`).join("")}</div>`;
  pintarAvatar($("phAvatar"));
}
$("accountForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const url = (id) => { const v = $(id).value.trim(); return /^https?:\/\/\S+\.\S+/.test(v) ? v : ""; };
  const f = { ...ficha(), titular: $("aTitular").value.trim(), lugar: $("aLugar").value.trim(), linkedin_url: url("aLinkedin"), web: url("aWeb"), sobre: $("aSobre").value.trim() };
  try {
    await updatePerfil({ nombre: $("aName").value.trim(), compartir_con_coordinacion: $("aShare").checked });
    try { await updatePerfil({ ficha: f }); } catch { $("aToast").textContent = "Nombre guardado. Para guardar el resto falta actualizar la base de datos (008_perfil.sql)."; enterApp(); return; }
    $("aToast").textContent = "Guardado"; enterApp(); renderPerfil();
  } catch { $("aToast").textContent = "No se pudo guardar."; }
});
/** Square-crops and shrinks a photo in the browser, so the profile only stores a small image. */
function recortarFoto(file, size = 256) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const lado = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d").drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, size, size);
      URL.revokeObjectURL(url); ok(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("No se pudo abrir esa imagen. Prueba con una foto JPG o PNG.")); };
    img.src = url;
  });
}
$("pFoto").addEventListener("change", async (ev) => {
  const f = ev.target.files?.[0]; ev.target.value = ""; if (!f) return;
  const msg = $("pFotoMsg");
  if (f.size > 15 * 1024 * 1024) { msg.textContent = "La foto supera los 15 MB."; return; }
  msg.textContent = "Guardando tu foto…";
  try { await updatePerfil({ avatar: await recortarFoto(f) }); renderPerfil(); msg.textContent = "Foto guardada."; }
  catch (e) { msg.textContent = e.message?.startsWith("No se pudo abrir") ? e.message : "No se pudo guardar la foto. Si sigue fallando, falta actualizar la base de datos (008_perfil.sql)."; }
});
$("pQuitarFoto").onclick = async () => { try { await updatePerfil({ avatar: "" }); renderPerfil(); $("pFotoMsg").textContent = "Foto quitada."; } catch { $("pFotoMsg").textContent = "No se pudo quitar."; } };

/* LinkedIn: the person links their LinkedIn account (Sign In with LinkedIn) and Lumen brings their photo and name.
   The button only appears when the LinkedIn provider is enabled in Supabase. */
let linkedinActivo = null;
async function comprobarLinkedin() {
  if (linkedinActivo === null && publicCfg?.supabaseUrl) {
    try { const r = await fetch(publicCfg.supabaseUrl + "/auth/v1/settings", { headers: { apikey: publicCfg.supabaseAnonKey } }); linkedinActivo = !!(await r.json()).external?.linkedin_oidc; }
    catch { linkedinActivo = false; }
  }
  const conectado = (session.user.identities || []).some((i) => i.provider === "linkedin_oidc") || ficha().linkedin?.conectado;
  $("pLinkedin").hidden = !linkedinActivo;
  $("pLinkedin").lastChild.textContent = conectado ? " Volver a traer foto y nombre de LinkedIn" : " Traer foto y nombre de LinkedIn";
  $("pLinkedinNota").textContent = linkedinActivo ? (conectado ? "Tu cuenta está conectada con LinkedIn. Lumen solo lee tu nombre y tu foto." : "Te pedirá entrar en LinkedIn y dar permiso. Lumen solo lee tu nombre y tu foto.") : "";
}
const LI_KEY = "lumen_linkedin_pendiente";
$("pLinkedin").onclick = async () => {
  const msg = $("pFotoMsg");
  const conectado = (session.user.identities || []).some((i) => i.provider === "linkedin_oidc");
  if (conectado) { await importarLinkedin(); return; }
  try { localStorage.setItem(LI_KEY, "1"); } catch {}
  msg.textContent = "Abriendo LinkedIn…";
  const { error } = await sb.auth.linkIdentity({ provider: "linkedin_oidc", options: { redirectTo: location.origin } });
  if (error) {
    try { localStorage.removeItem(LI_KEY); } catch {}
    msg.textContent = /manual linking/i.test(error.message) ? "Falta activar «Allow manual linking» en Supabase (Authentication → Sign In / Providers). Avisa a la coordinación." : "No se pudo conectar con LinkedIn. Inténtalo de nuevo.";
  }
};
async function importarLinkedin() {
  const msg = $("pFotoMsg");
  msg.textContent = "Trayendo tu foto y tu nombre de LinkedIn…";
  try {
    const r = await (await api("/api/perfil", { accion: "linkedin" })).json();
    await loadPerfil();
    pintarAvatar($("avatar")); $("whoName").textContent = perfil.nombre || session.user.email;
    if (vista === "cuenta") fillPerfil();
    msg.textContent = r.foto ? "Listo: foto de LinkedIn guardada." : "Conectado con LinkedIn, pero no he podido traer tu foto (quizá no tienes una pública). Puedes subirla a mano.";
  } catch (e) { msg.textContent = e.message; }
}
/** Back from LinkedIn: finish what the person started. */
function alVolverDeLinkedin() {
  let pendiente = false;
  try { pendiente = localStorage.getItem(LI_KEY) === "1"; localStorage.removeItem(LI_KEY); } catch {}
  if (!pendiente) return;
  show("cuenta");
  if ((session.user.identities || []).some((i) => i.provider === "linkedin_oidc")) importarLinkedin();
  else $("pFotoMsg").textContent = "No se completó la conexión con LinkedIn.";
}
$("logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };
$("deleteAccount").onclick = async () => {
  const b = $("deleteAccount");
  if (!b.dataset.armed) {
    b.dataset.armed = "1"; b.textContent = "Pulsa otra vez: se borrará todo y no se puede deshacer";
    setTimeout(() => { delete b.dataset.armed; b.textContent = "Eliminar mi cuenta"; }, 6000); return;
  }
  b.disabled = true; $("accMsg").textContent = "Eliminando…";
  const { data } = await sb.auth.getSession();
  const r = await fetch("/api/account", { method: "DELETE", headers: { Authorization: "Bearer " + (data.session?.access_token || "") } });
  if (r.status === 204) { await sb.auth.signOut(); location.reload(); return; }
  b.disabled = false; $("accMsg").textContent = "No se pudo eliminar la cuenta. Inténtalo de nuevo.";
};

/* ================= Export ================= */
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type: type + ";charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function dossierHtml(obj, evs, nombre) {
  const sorted = [...evs].sort(byDate), h = totalHours(evs), [e1, e2] = ectsRange(h);
  const label = (e) => "E" + (sorted.indexOf(e) + 1);
  const evHtml = sorted.map((e) => {
    const s = scoresOf(e), v = e.verificacion || {};
    return `<section class="ev"><h3>${label(e)}. ${safe(e.titulo)}</h3>
<p class="meta">${safe(fmtDate(e.fecha))} · ${safe(e.contexto || "Contexto sin indicar")} · ${fmtN(num(e.horas))} h · ${e.tipo === "diario" ? "Registro de diario" : "Entrevista reflexiva"}</p>
<p><b>Resultados de aprendizaje:</b> ${(e.resultados || []).map(safe).join(", ") || "—"}</p>
${Object.entries(e.evidencias || {}).map(([k, t]) => `<p><b>${safe(EV_LABELS[k] || k)}:</b> ${safe(t)}</p>`).join("")}
${oficialValido(e) ? `<p><b>Acreditación oficial:</b> ${safe(e.oficial.tipo)} expedido por ${safe(e.oficial.emisor)}${e.oficial.fecha ? " el " + safe(fmtDate(e.oficial.fecha)) : ""}${e.oficial.codigo ? " · código de verificación " + safe(e.oficial.codigo) : ""}</p>` : `<p><b>Valoración preliminar:</b> validez ${s.validez}/3 · autenticidad ${s.autenticidad}/3 · suficiencia ${s.suficiencia}/3 · vigencia ${s.vigencia}/3</p>`}
<p><b>Pruebas adjuntas:</b> ${(e.artefactos || []).map((a) => safe(a.name)).join(", ") || "Ninguna"}</p>
<p><b>Confirmación de tercero:</b> ${v.nombre ? safe(v.nombre) + (v.rol ? " (" + safe(v.rol) + ")" : "") + (v.contacto ? " · " + safe(v.contacto) : "") + " · " + safe(v.estado) : "No indicada"}</p></section>`;
  }).join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Expediente de reconocimiento · ${safe(nombre || "")}</title><style>
body{font:15px/1.55 Georgia,serif;color:#1b2438;max-width:860px;margin:40px auto;padding:0 20px}h1,h2,h3{font-family:Helvetica,Arial,sans-serif}h1{margin-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}th,td{border:1px solid #ccd3df;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eef2f8}
.meta{color:#66718a;margin-top:-6px}.ev{border-top:1px solid #ccd3df;padding-top:8px;margin-top:18px}.note{background:#eef2f8;padding:12px;font-size:13px}.firma{margin-top:40px}
@media print{body{margin:0}.ev{break-inside:avoid}}
</style></head><body>
<h1>Expediente de reconocimiento de aprendizajes por experiencia</h1>
<p class="meta">Generado con Lumen el ${new Date().toLocaleDateString("es-ES")}</p>
<h2>1. Solicitud</h2>
<table><tr><th>Solicitante</th><td>${safe(nombre || "—")}</td></tr><tr><th>Universidad</th><td>${safe(obj.universidad || "—")}</td></tr><tr><th>Titulación</th><td>${safe(obj.titulacion || "—")}</td></tr><tr><th>Código RUCT del título</th><td>${safe(obj.codigo_ruct || "—")}</td></tr><tr><th>Asignatura</th><td>${safe(obj.asignatura || "—")}${obj.codigo_asignatura ? " (código " + safe(obj.codigo_asignatura) + ")" : ""}${obj.ects ? " · " + safe(fmtN(Number(obj.ects))) + " ECTS" : ""}${obj.caracter ? " · " + safe(obj.caracter) : ""}${obj.curso_academico ? " · curso " + safe(obj.curso_academico) : ""}</td></tr>
<tr><th>Convenio con Lumen</th><td>${obj.estado === "publicada" ? "Sí" : obj.estado === "detectada" ? "Todavía no (asignatura real de un título oficial; Lumen gestiona el acuerdo)" : "—"}</td></tr>
<tr><th>Guía docente oficial</th><td>${obj.fuente_url ? `<a href="${safe(obj.fuente_url)}">${safe(obj.fuente_url)}</a>` : "—"}</td></tr>
<tr><th>Progreso</th><td>${obj.resultados.length ? `${progressOf(obj, evs).pct} % (${progressOf(obj, evs).ready} de ${obj.resultados.length} resultados de aprendizaje listos para presentar)` : "—"}</td></tr>
<tr><th>Horas documentadas</th><td>${fmtN(h)} h (equivalencia orientativa: ${fmtN(e1)}–${fmtN(e2)} ECTS, a 25–30 h por crédito)</td></tr></table>
<h2>2. Correspondencia con los resultados de aprendizaje</h2>
<table><tr><th>Resultado</th><th>Evidencias</th><th>Horas</th><th>Producto</th><th>Tercero</th><th>Estado</th></tr>
${obj.resultados.map((r) => { const s = outcomeStatus(r, evs); return `<tr><td><b>${safe(r.id)}</b> ${safe(r.texto)}</td><td>${s.linked.map(label).join(", ") || "—"}</td><td>${fmtN(s.horas)}</td><td>${s.checks.producto ? "Sí" : "No"}</td><td>${s.checks.tercero ? "Sí" : "No"}</td><td>${s.label}</td></tr>`; }).join("")}</table>
<h2>3. Evidencias</h2>${evHtml || "<p>Sin evidencias registradas.</p>"}
<h2>4. Declaración</h2>
<p>Declaro que las actividades y aprendizajes descritos en este expediente son ciertos y han sido realizados por mí, y que las pruebas aportadas son auténticas.</p>
<p class="firma">Firma: ______________________ &nbsp;&nbsp; Fecha: ______________</p>
<p class="note">La valoración de este documento es preliminar y autoinformada. Las puntuaciones de validez y suficiencia son estimaciones automáticas para orientar a la persona solicitante. Los archivos de prueba están disponibles en la plataforma Lumen. El reconocimiento de créditos corresponde exclusivamente a la universidad, conforme a su normativa.</p>
</body></html>`;
}
$("exportHtml").onclick = () => acDe(acActual) && download(`lumen-expediente-${normalize(objetivo.asignatura).replace(/\W+/g, "-")}.html`, dossierHtml(objetivo, evsDe(acActual), perfil.nombre), "text/html");
$("exportJson").onclick = () => download("lumen-mis-datos.json", JSON.stringify({ plataforma: "Lumen", exportado: new Date().toISOString(), aviso: "Declaraciones autoinformadas, pendientes de evaluación por la universidad", perfil: { nombre: perfil.nombre, consentimiento_at: perfil.consentimiento_at, compartir_con_coordinacion: perfil.compartir_con_coordinacion, trayectoria: perfil.trayectoria, ficha: perfil.ficha, foto: perfil.avatar ? "incluida en la cuenta" : "" }, acreditaciones: acreditaciones.map((ac) => ({ asignatura: subjectOf(ac), estado: ac.estado, creada: ac.created_at, conversacion: ac.conversacion, recursos: ac.recursos })), evidencias: evidences }, null, 2), "application/json");

/* ================= Auth screens ================= */
$("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = $("loginEmail").value.trim(); $("loginError").textContent = ""; $("loginBtn").disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
  $("loginBtn").disabled = false;
  if (error) {
    $("loginError").textContent = /signups not allowed|not found/i.test(error.message) ? "Este correo no está dado de alta en el piloto. Escribe a la coordinación para que te inviten." : error.status === 429 ? "Has pedido varios enlaces seguidos. Espera un minuto e inténtalo de nuevo." : "No se pudo enviar el enlace. Revisa el correo e inténtalo de nuevo.";
    return;
  }
  $("sentTo").textContent = email; showScreen("sent");
});
$("sentBack").onclick = () => showScreen("login");
let pendingTrace = null;
$("cTray").addEventListener("change", () => { $("cPistasBox").hidden = !$("cTray").checked; });
$("consentForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!$("cAccept").checked) { $("consentError").textContent = "Para participar tienes que aceptar la información sobre protección de datos."; return; }
  try {
    await updatePerfil({ nombre: $("cName").value.trim(), consentimiento_at: new Date().toISOString(), consentimiento_version: CONSENT_VERSION, compartir_con_coordinacion: $("cShare").checked });
    if ($("cTray").checked) pendingTrace = { nombre: $("cName").value.trim(), pistas: $("cPistas").value.trim() };
    route();
  } catch { $("consentError").textContent = "No se pudo guardar. Inténtalo de nuevo."; }
});

/* ================= Learning resources ================= */
const ICONO_RECURSO = { Libro: "📖", "Vídeo": "🎬", "Artículo": "📰", "Pódcast": "🎧", Curso: "🎓" };
let recommending = false;
/** Outcomes that still need evidence, weakest first. */
const pendingOutcomes = () => { const evs = evsDe(acActual); return objetivo.resultados.map((r) => ({ r, n: outcomeStatus(r, evs).n })).filter((x) => x.n < 5).sort((a, b) => a.n - b.n).map((x) => x.r.id).slice(0, 6); };
async function requestResources() {
  const ac = acDe(acActual);
  if (recommending || !ac || !aiOk) { if (!aiOk) $("recMsg").textContent = "La IA no está disponible ahora mismo."; return; }
  const pend = pendingOutcomes();
  if (!pend.length) { $("recMsg").textContent = "Ya tienes todos los resultados de aprendizaje listos."; return; }
  recommending = true;
  const btn = $("recBtn"); btn.disabled = true; btn.textContent = "Buscando recursos…";
  $("recMsg").textContent = "Lumen está buscando libros, vídeos, artículos y pódcast reales. Tarda uno o dos minutos.";
  try {
    const r = await (await api("/api/recursos", { acreditacion_id: ac.id, resultados: pend })).json();
    ac.recursos = r.recursos;
    $("recMsg").textContent = r.nuevos ? `${r.nuevos} recursos nuevos.` : "No he encontrado recursos nuevos. Vuelve a intentarlo más tarde.";
  } catch (e) { aiProblem(e); $("recMsg").textContent = e.message; }
  finally { recommending = false; btn.disabled = false; btn.textContent = "Recomiéndame recursos"; if (acActual === ac.id) renderResources(); }
}
function renderResources() {
  const ac = acDe(acActual);
  $("recSection").hidden = !ac || !objetivo.resultados.length;
  if ($("recSection").hidden) return;
  const vivos = (ac.recursos?.items || []).filter((x) => x.estado !== "descartado"), evs = evsDe(ac.id);
  if (!vivos.length) { $("recList").innerHTML = recommending ? "" : '<div class="empty">Pulsa «Recomiéndame recursos» y Lumen buscará material para lo que te falta en esta acreditación.</div>'; return; }
  $("recList").innerHTML = objetivo.resultados.filter((r) => vivos.some((x) => x.resultado_id === r.id)).map((r) => {
    const s = outcomeStatus(r, evs);
    return `<div class="rec-group"><h3><b>${safe(r.id)}</b> ${safe(r.texto)} <span class="pill ${s.cls}">${s.n}/5</span></h3>
      ${vivos.filter((x) => x.resultado_id === r.id).map((x) => {
        let host = ""; try { host = new URL(x.url).hostname.replace(/^www\./, ""); } catch {}
        return `<div class="rec${x.estado === "usado" ? " usado" : ""}"><span class="rec-icon" aria-hidden="true">${ICONO_RECURSO[x.tipo] || "📄"}</span>
          <div style="min-width:0"><a href="${safe(x.url)}" target="_blank" rel="noopener"><b>${safe(x.titulo)}</b></a>
            <small class="subtle">${safe(x.tipo)}${x.autor ? " · " + safe(x.autor) : ""}${x.idioma ? " · " + safe(x.idioma) : ""}${x.duracion ? " · " + safe(x.duracion) : ""} · ${safe(host)}</small>
            <p>${safe(x.por_que)}</p><p class="subtle">Para convertirlo en evidencia: ${safe(x.como_evidencia)}</p>
            <div class="row-actions" style="margin-top:6px">${x.estado === "usado" ? '<span class="pill ok">Documentado</span>' : `<button class="btn small accent" data-rec="usar" data-id="${safe(x.id)}">Ya lo he visto: documentarlo</button><button class="btn small" data-rec="descartar" data-id="${safe(x.id)}">No me interesa</button>`}</div></div></div>`;
      }).join("")}</div>`;
  }).join("");
}
$("recBtn").onclick = requestResources;
$("recList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-rec]"); if (!b) return;
  const ac = acDe(acActual), rec = ac?.recursos, x = rec?.items?.find((i) => i.id === b.dataset.id); if (!x) return;
  const items = rec.items.map((i) => (i.id === x.id ? { ...i, estado: b.dataset.rec === "usar" ? "usado" : "descartado" } : i));
  updateAc(ac, { recursos: { ...rec, items } }).then(renderResources).catch(() => {});
  if (b.dataset.rec === "usar") {
    setTab("chat"); if (busy) return;
    document.querySelectorAll(".choices").forEach((c) => c.remove());
    newDraft(); draft.titulo = x.titulo;
    bubble(`He ${x.tipo === "Libro" ? "leído" : x.tipo === "Pódcast" ? "escuchado" : "visto"} «${x.titulo}» y quiero documentar lo que aprendí. ${x.url}`, "user");
    await startTopic(`He ${x.tipo === "Libro" ? "leído" : x.tipo === "Pódcast" ? "escuchado" : "visto"} «${x.titulo}»${x.autor ? " de " + x.autor : ""}, recomendado para el resultado de aprendizaje ${x.resultado_id} (${objetivo.resultados.find((r) => r.id === x.resultado_id)?.texto || ""}). ${x.url}`);
  }
});

/* ================= My track record: import, review and timeline ================= */
const tray = () => perfil?.trayectoria || {};
const CONTEXTO_DE = { Trabajo: "Trabajo", Emprendimiento: "Trabajo", Proyecto: "Trabajo", "Charla o evento": "Trabajo", Voluntariado: "Voluntariado", "Formación": "Formación no reglada" };
const ICONO_TIPO = { Trabajo: "💼", Emprendimiento: "🚀", Proyecto: "🧩", Voluntariado: "🤝", "Formación": "🎓", "Publicación": "📰", "Premio o reconocimiento": "🏅", "Charla o evento": "🎤", Otro: "•" };
const ORIGEN_TXT = { cv: "De tu currículum", internet: "Encontrado en internet", "cv+internet": "Currículum + fuentes públicas" };
const fechaDe = (x) => { const f = x.fecha_fin || x.fecha_inicio || ""; return /^\d{4}-\d{2}$/.test(f) ? f + "-15" : /^\d{4}$/.test(f) ? f + "-06-30" : today(); };
const periodo = (x) => (x.fecha_inicio || x.fecha_fin ? [x.fecha_inicio, x.fecha_fin || (x.fecha_inicio ? "hoy" : "")].filter(Boolean).join(" – ") : "");
const pendientes = () => (tray().items || []).filter((x) => x.estado === "pendiente");

function evidenceFromTray(x) {
  const t = tray(), delCv = (x.origen || "").includes("cv") && t.cv?.path;
  const ev = { texto: [x.rol && `Papel: ${x.rol}.`, x.organizacion && `Organización: ${x.organizacion}.`, x.descripcion, x.contexto].filter(Boolean).join(" ") };
  if (x.logros?.length) ev.logros = x.logros.join("; ");
  if (x.competencias?.length) ev.competencias = x.competencias.join("; ");
  return {
    id: uid(), kind: "evidence", tipo: "trayectoria", titulo: x.titulo, fuente: x.tipo, url: x.fuentes[0]?.url || "", fecha: fechaDe(x), createdAt: Date.now(),
    contexto: CONTEXTO_DE[x.tipo] || "", horas: 0, resultados: [], evidencias: ev,
    criterios: { validez: 1, suficiencia: 1 }, falta: x.tipo === "Formación" ? "Aporta el título o certificado (PDF o foto) y Lumen lo verificará. Si quieres, cuenta además con 3 preguntas qué aprendiste y cómo lo aplicas." : "Complétala con 3 preguntas o con una entrevista: qué aprendiste, cómo lo aplicaste y cuántas horas le dedicaste. Si tienes un certificado que lo acredite, apórtalo.",
    artefactos: [
      ...x.fuentes.map((f) => ({ name: f.titulo.slice(0, 120), url: f.url, origen: "internet", subidoEl: new Date().toISOString() })),
      ...(delCv ? [{ name: t.cv.name || "Currículum", path: t.cv.path, origen: "cv", subidoEl: new Date().toISOString() }] : []),
    ],
    verificacion: { nombre: "", rol: "", contacto: "", estado: "sin solicitar" }, dialogue: [], ai: true,
  };
}

/** Reads the NDJSON progress stream of the import route. */
async function streamImport(body, onStep) {
  const r = await api("/api/trayectoria", body);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "", fin = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.tipo === "paso") onStep(ev.texto);
      else if (ev.tipo === "error") throw new Error(ev.mensaje);
      else if (ev.tipo === "fin") fin = ev;
    }
  }
  if (!fin) throw new Error("La carga se interrumpió antes de terminar. Vuelve a intentarlo.");
  return fin;
}
function logStep(texto) {
  const log = $("trayLog"); log.hidden = false;
  const li = document.createElement("li"); li.textContent = texto; log.append(li); log.scrollTop = log.scrollHeight;
}

let importing = false;
/** Loads the person's experience: CV and/or web search; what is clearly theirs becomes evidence straight away. */
async function runImport({ nombre, pistas = "", enlaces = [], cvFile = null, web }) {
  if (importing) return null;
  importing = true;
  const btn = $("tBuscar"); btn.disabled = true; btn.textContent = "Cargando tu experiencia…";
  $("trayLog").innerHTML = ""; $("trayLog").classList.remove("done"); $("tMsg").textContent = "Puede tardar unos minutos. No cierres la página.";
  try {
    let cv = null;
    if (cvFile) {
      if (cvFile.size > 10 * 1024 * 1024) throw new Error("El currículum supera los 10 MB.");
      logStep("Subiendo tu currículum");
      const a = await uploadFile(cvFile, "cv", "fuentes");
      cv = { path: a.path, name: cvFile.name };
    }
    const fin = await streamImport({ nombre, pistas, enlaces, cv, acepto: !!web }, logStep);
    let t = fin.trayectoria, cargadas = 0;
    perfil.trayectoria = t;
    const claras = t.items.filter((i) => i.estado === "pendiente" && i.confianza === "alta");
    for (const x of claras) {
      logStep(`Creando evidencias (${cargadas + 1} de ${claras.length})`);
      const e = evidenceFromTray(x);
      await saveEvidence(e);
      t = { ...t, items: t.items.map((i) => (i.id === x.id ? { ...i, estado: "confirmada", auto: true, evidencia_id: e.id } : i)) };
      perfil.trayectoria = t;
      cargadas++;
    }
    await updatePerfil({ trayectoria: t });
    if (cargadas) await relinkTodo(logStep);
    const porRevisar = t.items.filter((i) => i.estado === "pendiente").length;
    logStep(cargadas || porRevisar ? `Listo: ${cargadas} experiencias cargadas en tus evidencias${porRevisar ? ` y ${porRevisar} por revisar` : ""}` : "No he encontrado experiencias nuevas");
    $("trayLog").classList.add("done");
    $("tMsg").textContent = cargadas || porRevisar ? "" : "Prueba a subir tu currículum, o añade pistas y enlaces tuyos.";
    $("tCv").value = ""; setCvName(null);
    render();
    if (cargadas) maybeAutoPropose();
    return { cargadas, porRevisar };
  } catch (e) {
    aiProblem(e); $("tMsg").textContent = e.message; logStep("No se pudo completar la carga");
    return null;
  } finally { importing = false; btn.disabled = false; btn.textContent = "Cargar mi experiencia"; }
}
/** After many new evidences at once, one pass per accreditation is cheaper than one per evidence. */
async function relinkTodo(onStep = () => {}) {
  for (const ac of acreditaciones) {
    onStep(`Vinculando con «${subjectOf(ac).asignatura}»`);
    try { await relinkAc(ac.id); } catch (e) { aiProblem(e); }
  }
}
async function autoTraceOnSignup(p) {
  show("trayectoria");
  $("tNombre").value = p.nombre; $("tPistas").value = p.pistas || ""; $("tAcepto").checked = true;
  if (p.nombre.split(/\s+/).length < 2) { $("tMsg").textContent = "Para buscarte en internet necesito tu nombre y al menos un apellido."; return; }
  const r = await runImport({ nombre: p.nombre, pistas: p.pistas, web: true });
  if (r) bubble(`He buscado tu trayectoria en internet: ${r.cargadas} experiencia${r.cargadas === 1 ? "" : "s"} cargada${r.cargadas === 1 ? "" : "s"} en tus evidencias${r.porRevisar ? ` y ${r.porRevisar} por revisar` : ""}. Sube también tu currículum en «Mi trayectoria» para completarla.`);
}

function setCvName(f) { $("tCvName").textContent = f ? f.name : "Elige el archivo o arrástralo aquí"; $("tCvDrop").classList.toggle("has", !!f); }
$("tCv").addEventListener("change", (ev) => setCvName(ev.target.files?.[0] || null));
for (const type of ["dragover", "dragleave", "drop"]) $("tCvDrop").addEventListener(type, (ev) => {
  ev.preventDefault(); $("tCvDrop").classList.toggle("over", type === "dragover");
  if (type === "drop" && ev.dataTransfer?.files?.[0]) { $("tCv").files = ev.dataTransfer.files; setCvName(ev.dataTransfer.files[0]); }
});
$("trayForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const cvFile = $("tCv").files?.[0] || null, web = $("tAcepto").checked, nombre = $("tNombre").value.trim();
  if (!cvFile && !web) { $("tMsg").textContent = "Sube tu currículum o marca la casilla para que Lumen te busque en internet."; return; }
  if (web && nombre.split(/\s+/).length < 2) { $("tMsg").textContent = "Para buscarte en internet, escribe tu nombre y al menos un apellido."; return; }
  if (cvFile && !/\.(pdf|txt|md)$/i.test(cvFile.name)) { $("tMsg").textContent = "Sube el currículum en PDF (desde Word: Archivo → Guardar como PDF)."; return; }
  runImport({ nombre, pistas: $("tPistas").value.trim(), enlaces: $("tEnlaces").value.split("\n").map((x) => x.trim()).filter(Boolean), cvFile, web });
});

const sourcesHtml = (x) => (x.fuentes?.length ? `<div class="sources">${x.fuentes.map((f) => { let h = f.url; try { h = new URL(f.url).hostname.replace(/^www\./, ""); } catch {} return `<a href="${safe(f.url)}" target="_blank" rel="noopener">${safe(f.titulo.slice(0, 90))} · ${safe(h)}</a>`; }).join("")}</div>` : "");
const skillsHtml = (x) => (x.competencias?.length ? `<div class="chips">${x.competencias.map((c) => `<span class="pill">${safe(c)}</span>`).join("")}</div>` : "");
function renderTrayectoria() {
  const t = tray();
  if (!$("tNombre").value) $("tNombre").value = t.nombre || perfil.nombre || "";
  if (!$("tPistas").value) $("tPistas").value = t.pistas || [ficha().titular, ficha().lugar].filter(Boolean).join(", ");
  if (!$("tEnlaces").value && (ficha().linkedin_url || ficha().web)) $("tEnlaces").value = [ficha().linkedin_url, ficha().web].filter(Boolean).join("\n");
  const items = t.items || [], pend = items.filter((x) => x.estado === "pendiente"), vivos = items.filter((x) => x.estado === "confirmada");
  $("trayBadge").hidden = !pend.length; $("trayBadge").textContent = pend.length;

  $("trayReview").hidden = !pend.length;
  $("trayReviewTitle").textContent = `Por revisar (${pend.length})`;
  const conf_cls = { alta: "ok", media: "warn", baja: "" };
  $("trayList").innerHTML = pend.map((x) => `<article class="card">
      <div class="card-head"><div style="min-width:0"><b>${ICONO_TIPO[x.tipo] || "•"} ${safe(x.titulo)}</b><small>${safe(x.tipo)}${x.organizacion ? " · " + safe(x.organizacion) : ""}${x.rol ? " · " + safe(x.rol) : ""}${periodo(x) ? " · " + safe(periodo(x)) : ""}</small></div>
        <span class="facts"><span class="pill">${safe(ORIGEN_TXT[x.origen] || ORIGEN_TXT.internet)}</span><span class="pill ${conf_cls[x.confianza] || ""}">Confianza ${safe(x.confianza)}</span></span></div>
      <p>${safe(x.descripcion)}</p>
      <p class="subtle">${safe(x.motivo_confianza)}</p>
      ${skillsHtml(x)}${sourcesHtml(x)}
      <div class="row-actions"><button class="btn small accent" data-tray="si" data-id="${safe(x.id)}">Es mío: crear evidencia</button><button class="btn small" data-tray="no" data-id="${safe(x.id)}">No soy yo</button></div>
    </article>`).join("");

  $("trayLineBox").hidden = !vivos.length;
  const clave = (x) => x.fecha_fin || x.fecha_inicio || "";
  const sorted = [...vivos].sort((a, b) => (clave(b) || "0").localeCompare(clave(a) || "0"));
  let year = null, html = "";
  for (const x of sorted) {
    const y = clave(x).slice(0, 4) || "Sin fecha";
    if (y !== year) { year = y; html += `<div class="tl-year">${safe(y)}</div>`; }
    const e = evidences.find((i) => i.id === x.evidencia_id), s = e ? scoresOf(e) : null, completa = s && s.suficiencia >= 2;
    html += `<div class="tl-item${completa ? " ok" : ""}"><span class="tl-icon" aria-hidden="true">${ICONO_TIPO[x.tipo] || "•"}</span>
      <div class="tl-body"><b>${safe(x.titulo)}</b><small>${safe(x.tipo)}${x.organizacion ? " · " + safe(x.organizacion) : ""}${periodo(x) ? " · " + safe(periodo(x)) : ""} · ${safe(ORIGEN_TXT[x.origen] || ORIGEN_TXT.internet)}${x.fuentes?.length ? ` · ${x.fuentes.length} fuente${x.fuentes.length > 1 ? "s" : ""}` : ""}</small>
        <p>${safe(x.descripcion)}</p>${skillsHtml(x)}
        <div class="row-actions" style="margin-top:8px">${completa ? '<span class="pill ok">Evidencia completa</span>' : '<span class="pill warn">Falta profundidad</span>'}
          ${e && !completa ? `<button class="btn small accent" data-tray="completar" data-id="${safe(x.id)}">Completar con 3 preguntas</button>` : ""}
          <button class="btn small" data-tray="entrevista" data-id="${safe(x.id)}">Entrevista</button><button class="btn small" data-tray="quitar" data-id="${safe(x.id)}">No soy yo</button></div></div></div>`;
  }
  $("trayLine").innerHTML = html;
}
async function decideTray(x, accion, lote = false) {
  const t = tray();
  let evId = null;
  if (accion === "si") { const e = evidenceFromTray(x); evId = e.id; await saveEvidence(e); if (!lote) vincularEnArbol(e); }
  if (accion === "quitar" && x.evidencia_id) { const e = evidences.find((i) => i.id === x.evidencia_id); if (e) await deleteEvidence(e); }
  const items = tray().items.map((i) => (i.id === x.id ? { ...i, estado: accion === "si" ? "confirmada" : "descartada", evidencia_id: evId, auto: false } : i));
  await updatePerfil({ trayectoria: { ...t, items } });
  return evId;
}
async function onTrayClick(ev) {
  const b = ev.target.closest("[data-tray]"); if (!b) return;
  const x = (tray().items || []).find((i) => i.id === b.dataset.id); if (!x) return;
  if (b.dataset.tray === "entrevista") {
    show("agente"); if (busy) return;
    document.querySelectorAll(".choices").forEach((c) => c.remove());
    newDraft(); bubble(`Quiero profundizar en «${x.titulo}».`, "user");
    await startTopic(`${x.titulo}${x.organizacion ? " (" + x.organizacion + ")" : ""}. ${x.descripcion}`);
    return;
  }
  if (b.dataset.tray === "completar") { show("evidencias"); openQuick(x.evidencia_id); return; }
  b.disabled = true;
  try {
    const evId = await decideTray(x, b.dataset.tray);
    render();
    if (evId) maybeAutoPropose();
  } catch (e) { b.disabled = false; $("tMsg").textContent = e.message || "No se pudo guardar."; }
}
$("trayList").addEventListener("click", onTrayClick);
$("trayLine").addEventListener("click", onTrayClick);
$("trayAll").onclick = async () => {
  const btn = $("trayAll"); btn.disabled = true; btn.textContent = "Creando evidencias…";
  try { for (const x of pendientes()) await decideTray(x, "si", true); render(); await relinkTodo(); maybeAutoPropose(); }
  finally { btn.disabled = false; btn.textContent = "Todo esto es mío"; }
};

/* ================= Complete an evidence with three questions ================= */
const quickState = {};
const PREGUNTAS_BASE = (e) => [
  `En «${e.titulo}», ¿qué hiciste tú exactamente y qué aprendiste? Cuenta un caso concreto.`,
  "Describe una decisión o un problema real de esa experiencia: qué hiciste, con qué criterio y qué resultado obtuviste (con alguna cifra si puedes).",
  "¿Qué límites tiene lo que sabes de esto, y quién podría confirmar tu trabajo (nombre y rol)?",
];
async function openQuick(evId, acId = null) {
  const e = evidences.find((x) => x.id === evId); if (!e) return;
  if (!quickState[evId]) {
    quickState[evId] = { cargando: true, preguntas: [], respuestas: ["", "", ""], horas: e.horas || "", ac: acId };
    render();
    let preguntas = PREGUNTAS_BASE(e);
    if (aiOk) {
      try { const r = await (await api("/api/analyze", { kind: "preguntas", acreditacion_id: acId, titulo: e.titulo, resumen: Object.values(e.evidencias || {}).join(" ") })).json(); if (r.preguntas?.length === 3) preguntas = r.preguntas; }
      catch (err) { aiProblem(err); }
    }
    Object.assign(quickState[evId], { cargando: false, preguntas });
  }
  render();
  document.getElementById("qk-" + evId)?.scrollIntoView({ behavior: "smooth", block: "center" });
}
function quickHtml(e) {
  const q = quickState[e.id]; if (!q) return "";
  const id = safe(e.id);
  if (q.cargando) return `<div class="quick" id="qk-${id}">Lumen está preparando tres preguntas sobre esta experiencia…</div>`;
  return `<div class="quick" id="qk-${id}">
    ${q.preguntas.map((p, i) => `<label class="field">${safe(p)}<textarea data-quick="${id}" data-i="${i}" rows="3">${safe(q.respuestas[i])}</textarea></label>`).join("")}
    <label class="field" style="max-width:240px">Horas que le dedicaste (aproximadas)<input type="number" min="0" step="1" data-quick="${id}" data-i="horas" value="${safe(q.horas)}"></label>
    <div class="row-actions" style="margin-top:0"><button class="btn small accent" data-act="quicksave" data-id="${id}"${q.guardando ? " disabled" : ""}>${q.guardando ? "Analizando tus respuestas…" : "Guardar respuestas"}</button><button class="btn small" data-act="quickcancel" data-id="${id}">Cancelar</button><span class="toast">${safe(q.msg || "")}</span></div>
  </div>`;
}
async function saveQuick(e) {
  const q = quickState[e.id];
  if (q.respuestas.filter((r) => r.trim().length > 20).length < 2) { q.msg = "Responde al menos a dos preguntas, con algo de detalle."; render(); return; }
  q.guardando = true; q.msg = ""; render();
  const resumen = Object.values(e.evidencias || {}).join(" ");
  const history = [{ role: "user", content: `Experiencia: ${e.titulo}. ${resumen}`.slice(0, 5000) }];
  q.preguntas.forEach((p, i) => { if (q.respuestas[i].trim()) history.push({ role: "assistant", content: p }, { role: "user", content: q.respuestas[i].trim().slice(0, 5000) }); });
  if (num(q.horas)) history.push({ role: "assistant", content: "¿Cuántas horas le dedicaste?" }, { role: "user", content: `Unas ${num(q.horas)} horas.` });
  const n = structuredClone(e), texto = q.respuestas.join(" ");
  try {
    let o = null;
    if (aiOk) { try { o = await (await api("/api/analyze", { kind: "interview", acreditacion_id: q.ac, titulo: e.titulo, history })).json(); } catch (err) { aiProblem(err); } }
    if (o) {
      for (const k of ["idea", "aplicacion", "argumentacion", "conexion", "limites"]) if (o.evidencias?.[k]?.trim()) n.evidencias[k] = o.evidencias[k].trim();
      n.criterios = { validez: clamp03(o.validez), suficiencia: clamp03(o.suficiencia) };
      n.falta = o.falta || "";
      if (q.ac && o.resultados?.length) n.vinculos = { ...(n.vinculos || {}), [q.ac]: [...new Set([...(n.vinculos?.[q.ac] || []), ...o.resultados])] };
      if (CONTEXTOS.includes(o.contexto) && !n.contexto) n.contexto = o.contexto;
      if (o.verificador_nombre && !n.verificacion?.nombre) n.verificacion = { ...n.verificacion, nombre: o.verificador_nombre, rol: o.verificador_rol || "" };
      n.horas = num(q.horas) || num(o.horas) || n.horas;
    } else {
      [["idea", 0], ["aplicacion", 1], ["limites", 2]].forEach(([k, i]) => { if (q.respuestas[i].trim()) n.evidencias[k] = q.respuestas[i].trim(); });
      n.criterios = { validez: Math.max(1, clamp03(n.criterios?.validez)), suficiencia: texto.length > 500 ? 2 : 1 };
      n.horas = num(q.horas) || n.horas;
      if (q.ac && !n.vinculos?.[q.ac]?.length) n.vinculos = { ...(n.vinculos || {}), [q.ac]: ruleLink(texto + " " + e.titulo) };
    }
    n.dialogue = [...(n.dialogue || []), ...history.slice(1).map((m) => ({ role: m.role, text: m.content }))];
    delete quickState[e.id];
    await saveEvidence(n);
    vincularEnArbol(n, q.ac ? [q.ac] : []);
  } catch (err) { q.guardando = false; q.msg = err.message; render(); }
}

/* ================= Google Drive ================= */
// Uses the Google Picker with the drive.file scope: Lumen only ever sees the files the person picks.
const loadScript = (src) => new Promise((ok, ko) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ko(new Error("No se pudo cargar Google Drive.")); document.head.append(s); });
let googleReady = null, driveToken = null, driveTokenExp = 0;
function ensureGoogle() {
  googleReady ??= Promise.all([loadScript("https://apis.google.com/js/api.js"), loadScript("https://accounts.google.com/gsi/client")])
    .then(() => new Promise((ok) => gapi.load("picker", ok)));
  return googleReady;
}
function driveAccessToken() {
  if (driveToken && Date.now() < driveTokenExp) return Promise.resolve(driveToken);
  return new Promise((ok, ko) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: googleCfg.clientId, scope: "https://www.googleapis.com/auth/drive.file",
      callback: (r) => { if (r.error) return ko(new Error("No se pudo conectar con Google Drive.")); driveToken = r.access_token; driveTokenExp = Date.now() + (Number(r.expires_in) - 60) * 1000; ok(driveToken); },
      error_callback: () => ko(new Error("Se canceló la conexión con Google Drive.")),
    });
    client.requestAccessToken({ prompt: driveToken ? "" : "consent" });
  });
}
const GOOGLE_EXPORT = { "application/vnd.google-apps.document": "application/pdf", "application/vnd.google-apps.presentation": "application/pdf", "application/vnd.google-apps.spreadsheet": "application/pdf", "application/vnd.google-apps.drawing": "application/pdf" };
/** Opens the Drive picker (folders can be browsed; files inside them are selected) and returns the chosen files. */
async function pickDriveFiles({ multiple = true } = {}) {
  if (!googleCfg) throw new Error("Google Drive no está configurado.");
  await ensureGoogle();
  const token = await driveAccessToken();
  const docs = await new Promise((ok) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
    const builder = new google.picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(googleCfg.apiKey).setAppId(googleCfg.appId).setLocale("es")
      .setTitle("Elige los archivos (entra en las carpetas para verlos)")
      .setCallback((d) => { if (d.action === google.picker.Action.PICKED) ok(d.docs); else if (d.action === google.picker.Action.CANCEL) ok([]); });
    if (multiple) builder.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
    builder.build().setVisible(true);
  });
  const files = [];
  for (const d of docs.slice(0, 10)) {
    const exportAs = GOOGLE_EXPORT[d.mimeType];
    const url = exportAs ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(d.id)}/export?mimeType=${encodeURIComponent(exportAs)}` : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(d.id)}?alt=media`;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw new Error(`No se pudo descargar «${d.name}» de Drive${exportAs ? " (los documentos muy grandes no se pueden convertir)" : ""}.`);
    const blob = await r.blob();
    files.push(new File([blob], exportAs && !/\.pdf$/i.test(d.name) ? d.name + ".pdf" : d.name, { type: exportAs || blob.type || d.mimeType }));
  }
  return files;
}

/* ================= Composer: attach and dictate ================= */
$("chatFile").addEventListener("change", (ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; if (f) attachSource(f); });
$("chatDrive").onclick = async () => {
  try { const [f] = await pickDriveFiles({ multiple: false }); if (f) attachSource(f); }
  catch (e) { bubble(e.message); }
};
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if (!Recognition) $("mic").hidden = true;
$("mic").onclick = () => {
  if (rec) { rec.stop(); return; }
  rec = new Recognition();
  rec.lang = "es-ES"; rec.interimResults = true; rec.continuous = true;
  const base = $("answer").value ? $("answer").value.replace(/\s*$/, " ") : "";
  rec.onresult = (ev) => { let t = ""; for (const r of ev.results) t += r[0].transcript; $("answer").value = base + t; };
  rec.onerror = (ev) => { $("helpLine").textContent = ev.error === "not-allowed" ? "Para dictar, permite el uso del micrófono en tu navegador." : "No se pudo usar el dictado. Escribe tu respuesta."; };
  rec.onend = () => { rec = null; $("mic").classList.remove("on"); $("mic").setAttribute("aria-label", "Dictar respuesta"); $("answer").focus(); };
  rec.start();
  $("mic").classList.add("on"); $("mic").setAttribute("aria-label", "Detener dictado");
  $("helpLine").textContent = "Escuchando… Pulsa el micrófono para terminar y revisa el texto antes de enviarlo.";
};

/* ================= Composer ================= */
function respond() { if (rec) rec.stop(); const v = $("answer").value; if (v.trim()) submit(v); }
$("send").onclick = respond;
$("answer").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); respond(); } });

boot();
