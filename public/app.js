"use strict";
const $ = (id) => document.getElementById(id);
const MAX_TURNS = 7, HOURS_PER_ECTS_MIN = 25, HOURS_PER_ECTS_MAX = 30, VIGENCIA_YEARS = 5;
const CONSENT_VERSION = "piloto-v1";
const BUCKET = "artefactos";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Before choosing an official subject there are no learning outcomes to link evidence to. */
const NO_OBJ = { universidad: "", titulacion: "", asignatura: "", ects: "", resultados: [], sinObjetivo: true };
const EV_LABELS = { idea: "Qué aprendió", aplicacion: "Aplicación", argumentacion: "Argumentación", conexion: "Conexión con su experiencia", limites: "Límites y dudas", sintesis: "Síntesis final", texto: "Registro del diario", fidelidad: "Fidelidad al contenido" };
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
let sb = null, session = null, perfil = null, objetivo = NO_OBJ, evidences = [], catalogo = [];

function showScreen(name) {
  for (const [id, n] of [["sLoading", "loading"], ["sLogin", "login"], ["sSent", "sent"], ["sConsent", "consent"], ["sApp", "app"]]) $(id).hidden = n !== name;
}

async function boot() {
  try {
    const cfg = await fetch("/api/config").then((r) => { if (!r.ok) throw new Error(); return r.json(); });
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
    await Promise.all([loadEvidences(), loadCatalog()]);
    objetivo = resolveObjetivo(perfil.objetivo);
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
  const paths = (e.artefactos || []).map((a) => a.path).filter(Boolean);
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
  const art = (e.artefactos || []).length > 0, conf = e.verificacion?.estado === "confirmada";
  if (art && conf) return 3; if (conf || art) return 2;
  if (e.contexto && e.fecha && e.horas > 0) return 1; return 0;
}
function vigencia(e) { const y = yearsAgo(e.fecha); return y <= 2 ? 3 : y <= VIGENCIA_YEARS ? 2 : y <= 10 ? 1 : 0; }
function scoresOf(e) { return { validez: clamp03(e.criterios?.validez), suficiencia: clamp03(e.criterios?.suficiencia), autenticidad: autenticidad(e), vigencia: vigencia(e) }; }
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
}
const PHASES = { intent: "Buscando qué puedes acreditar", start: "Preparado para acompañarte", type: "Eligiendo qué documentar", titleAsk: "Eligiendo qué documentar", dialogue: "Recogiendo evidencias", review: "Síntesis final", done: "Evidencia registrada" };
function setPhase() { $("phase").textContent = PHASES[stage] || "En conversación"; }
function ask(text, options) { bubble(text); setPhase(); if (options) choices(options); $("answer").focus(); }

let stage = "start", draft = null, busy = false;
function newDraft() {
  draft = { id: uid(), titulo: "", fuente: "", url: "", material: null, turns: [], used: [], history: [], createdAt: Date.now() };
}
function begin(seed) {
  newDraft();
  if (seed) { startTopic(seed); return; }
  stage = "type";
  ask("¿Qué quieres hacer hoy? Cuéntame algo que hayas aprendido (una tarea del trabajo, un proyecto, un voluntariado, un curso o algo que resolviste en tu vida diaria), pega el enlace o el título de lo que viste, escuchaste o leíste, o adjunta el material con el clip 📎. También puedes decirme qué te gustaría acreditar.", ["Una tarea de mi trabajo", "Un proyecto que llevé", "Un voluntariado", "Un curso, libro o podcast", "Quiero acreditar algo concreto"]);
}
function setBusy(b) { busy = b; $("send").disabled = b; }

async function agentTurn(userText, { closing = false } = {}) {
  const el = bubble("Pensando…"); el.classList.add("thinking"); setPhase(); setBusy(true);
  try {
    if (!aiOk) throw new Error("offline");
    const r = await api("/api/chat", { titulo: draft.titulo, history: draft.history, closing, fuente: draft.material && { path: draft.material.path, name: draft.material.name } });
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
  } catch (e) {
    if (e.status === 429 || e.status === 403) aiState(false, e.message);
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
  draft.history.push({ role: "user", content: value });
  await agentTurn(value);
}
async function readLink(url) {
  const el = bubble("Abriendo el enlace…"); el.classList.add("thinking"); setBusy(true);
  try {
    const { fuente } = await (await api("/api/fuente", { url, draftId: draft.id })).json();
    draft.material = fuente;
    if (draft.titulo === url) draft.titulo = fuente.name;
    el.textContent = fuente.leido ? `He leído «${fuente.name}». Te preguntaré a partir de su contenido.`
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
  if (stage === "done" && value === "Ver mis evidencias") { show("evidencias"); return; }
  if (value === "Ver propuestas de acreditación") { show("objetivo"); $("propSection").scrollIntoView(); return; }
  bubble(value, "user"); $("answer").value = "";
  if (stage === "start" || stage === "done") {
    if (/^(empezar|documentar)/.test(normalize(value))) { begin(); return; }
    begin(value); return;
  }
  if (stage === "type" && value === "Quiero acreditar algo concreto") {
    stage = "intent"; ask("¿Qué te gustaría que te reconocieran? Dímelo con tus palabras: una asignatura, una titulación o una competencia."); return;
  }
  if (stage === "intent") {
    const el = bubble("Buscando cómo encaja con lo que ya has documentado…"); el.classList.add("thinking"); setBusy(true);
    try {
      const list = await requestProposals(value);
      const p = list?.find((x) => x.origen === "usuario" && x.estado === "nueva");
      el.classList.remove("thinking");
      el.textContent = p ? `En el catálogo oficial encaja «${p.asignatura}» (${p.titulacion}, ${p.universidad}, ${fmtN(p.ects)} ECTS). Con lo que has documentado, cubres un ${p.encaje} % de sus resultados de aprendizaje. ${p.motivo}${p.siguientes_pasos?.[0] ? "\n\nPrimer paso: " + p.siguientes_pasos[0] : ""}${lastNoMatch ? "\n\n" + lastNoMatch : ""}` : `${lastNoMatch || "No he encontrado esa asignatura en el catálogo oficial de Lumen."} Puedes pedir a la coordinación que la añada desde «Acreditación».`;
      stage = "done"; setPhase(); choices(["Ver propuestas de acreditación", "Documentar otra cosa"]);
    } catch (e) {
      el.classList.remove("thinking"); el.textContent = e.message + " Puedes definir el objetivo a mano en «Acreditación».";
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
    const o = await (await api("/api/analyze", { kind: "interview", titulo: draft.titulo, history: draft.history, fuente: draft.material && { path: draft.material.path, name: draft.material.name } })).json();
    const ev = {}; for (const k of ["idea", "aplicacion", "argumentacion", "conexion", "limites", "fidelidad"]) if (o.evidencias?.[k]?.trim()) ev[k] = o.evidencias[k].trim();
    ev.sintesis = synthesis;
    return { ...o, evidencias: ev };
  } catch (e) {
    if (e.status === 429 || e.status === 403) aiState(false, e.message);
    return fallback;
  }
}

async function completeInterview(synthesis) {
  const el = bubble("Ordenando tus evidencias…"); el.classList.add("thinking"); setBusy(true);
  const r = await analyzeInterview(synthesis);
  const e = {
    id: draft.id, kind: "evidence", tipo: "entrevista", titulo: r.titulo || draft.titulo, fuente: draft.fuente, url: draft.url, material: draft.material,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(r.fecha) ? r.fecha : today(), createdAt: draft.createdAt,
    contexto: CONTEXTOS.includes(r.contexto) ? r.contexto : "", horas: num(r.horas), resultados: r.resultados || [], evidencias: r.evidencias,
    criterios: { validez: clamp03(r.validez), suficiencia: clamp03(r.suficiencia) }, falta: r.falta || "",
    artefactos: [], verificacion: { nombre: r.verificador_nombre || "", rol: r.verificador_rol || "", contacto: "", estado: "sin solicitar" },
    dialogue: draft.history.map((m) => ({ role: m.role, text: m.content })), ai: aiOk,
  };
  el.classList.remove("thinking");
  try {
    await saveEvidence(e);
    el.textContent = `He registrado «${e.titulo}» como evidencia${e.resultados.length ? " para " + e.resultados.join(", ") : ""}.${e.falta ? "\n\nPara que sea suficiente: " + e.falta : ""}\n\nEn «Mis evidencias» puedes adjuntar el producto, revisar las horas y pedir la confirmación de ${e.verificacion.nombre || "alguien que haya visto tu trabajo"}.`;
    stage = "done"; draft = null; setPhase(); choices(["Ver mis evidencias", "Documentar otra cosa"]);
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
    let link = { titulo: text.split(/[.!?\n]/)[0].slice(0, 70), resultados: ruleLink(text), validez: 1, suficiencia: text.length > 400 ? 2 : 1, falta: "Amplíala con una entrevista para ganar profundidad." };
    if (aiOk) {
      try { link = await (await api("/api/analyze", { kind: "diary", texto: text, contexto: $("dCtx").value, horas: num($("dHours").value) })).json(); }
      catch (e) { if (e.status === 429 || e.status === 403) aiState(false, e.message); }
    }
    await saveEvidence({
      id, kind: "evidence", tipo: "diario", titulo: link.titulo || text.slice(0, 70), fuente: "", url: "", fecha: $("dDate").value || today(), createdAt: Date.now(),
      contexto: $("dCtx").value, horas: num($("dHours").value), resultados: link.resultados || [], evidencias: { texto: text },
      criterios: { validez: clamp03(link.validez), suficiencia: clamp03(link.suficiencia) }, falta: link.falta || "",
      artefactos, verificacion: { nombre: "", rol: "", contacto: "", estado: "sin solicitar" }, dialogue: [], ai: aiOk,
    });
    $("dText").value = ""; $("dFile").value = ""; $("dHours").value = "1"; $("dDate").value = today();
    $("dToast").textContent = `Guardado${link.resultados?.length ? " · vinculado a " + link.resultados.join(", ") : ""}`;
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
function subjectFacts(o) {
  return [o.nivel, o.ects && fmtN(o.ects) + " ECTS", o.caracter, o.curso_academico && "Curso " + o.curso_academico, o.codigo_asignatura && "Código " + o.codigo_asignatura, o.codigo_ruct && "RUCT " + o.codigo_ruct].filter(Boolean).map((x) => `<span class="pill">${safe(x)}</span>`).join("");
}
function renderMiAcreditacion() {
  const box = $("miAcreditacion");
  if (objetivo.sinObjetivo) {
    box.innerHTML = `<h2>Tu acreditación</h2><div class="empty">Todavía no has elegido una asignatura. Busca la tuya en el catálogo oficial, di qué quieres acreditar o deja que Lumen te proponga una con tus evidencias.</div>`;
    return;
  }
  box.innerHTML = `<h2>Tu acreditación</h2>
    <div class="subject">
      <div class="subject-head"><div style="min-width:0"><b>${safe(objetivo.asignatura)}</b><small class="subtle">${safe(objetivo.titulacion)} · ${safe(objetivo.universidad)}</small></div>
        <a class="btn small" href="${safe(objetivo.fuente_url)}" target="_blank" rel="noopener">Guía docente oficial ↗</a></div>
      <div class="facts">${subjectFacts(objetivo)}</div>
      ${objetivo.estado === "retirada" ? '<p class="falta">La coordinación ha retirado esta asignatura del catálogo. Elige otra o consulta con la coordinación.</p>' : ""}
      ${progressHtml(objetivo, evidences)}
    </div>`;
}
function renderCatalog() {
  const q = normalize($("catSearch").value.trim());
  const list = catalogo.filter((a) => a.estado === "publicada" && (!q || normalize(`${a.asignatura} ${a.titulacion} ${a.universidad} ${a.codigo_asignatura}`).includes(q)));
  $("catList").innerHTML = list.length ? list.slice(0, 50).map((a) => `<div class="cat-row"><div style="min-width:0"><b>${safe(a.asignatura)}</b><small>${safe(a.titulacion)} · ${safe(a.universidad)} · ${fmtN(Number(a.ects))} ECTS · ${a.resultados.length} resultados de aprendizaje</small></div>
    <div class="row-actions" style="margin-top:0"><a class="btn small" href="${safe(a.fuente_url)}" target="_blank" rel="noopener">Guía ↗</a>${objetivo.asignatura_id === a.id ? '<span class="pill ok">Tu acreditación</span>' : `<button class="btn small accent" data-choose="${safe(a.id)}">Elegir</button>`}</div></div>`).join("")
    : `<div class="empty">${catalogo.some((a) => a.estado === "publicada") ? "Ninguna asignatura coincide con la búsqueda." : "El catálogo todavía está vacío. La coordinación del piloto añadirá las asignaturas disponibles."}</div>`;
}
$("catSearch").addEventListener("input", renderCatalog);
/** Sets an official subject as the target and re-links every evidence to its outcomes. */
async function setObjective(a, cobertura) {
  const obj = objFromSubject(a);
  await updatePerfil({ objetivo: { asignatura_id: a.id, asignatura: a.asignatura, titulacion: a.titulacion, universidad: a.universidad, ects: Number(a.ects), resultados: a.resultados } });
  objetivo = obj;
  if (!cobertura && evidences.length && aiOk) {
    try {
      const { propuestas: list } = await (await api("/api/analyze", { kind: "propose", intencion: `${a.asignatura} (${a.titulacion}, ${a.universidad})` })).json();
      perfil.propuestas = list;
      cobertura = list.find((p) => p.asignatura_id === a.id)?.cobertura;
    } catch {}
  }
  const byEv = new Map();
  for (const c of cobertura || []) for (const ev of c.evidencias) byEv.set(ev, [...(byEv.get(ev) || []), c.resultado_id]);
  for (const e of evidences) {
    const next = byEv.get(e.id) || [];
    if (JSON.stringify(next) !== JSON.stringify(e.resultados || [])) await saveEvidence({ ...structuredClone(e), resultados: next });
  }
  render();
}
$("catList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-choose]"); if (!b) return;
  const a = catalogo.find((x) => x.id === b.dataset.choose); if (!a) return;
  b.disabled = true; b.textContent = "Vinculando tus evidencias…";
  try { await setObjective(a); $("miAcreditacion").scrollIntoView({ behavior: "smooth" }); }
  catch { b.disabled = false; b.textContent = "Elegir"; }
});
$("requestForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const { error } = await sb.from("solicitudes_catalogo").insert({ texto: $("reqText").value.trim(), url: $("reqUrl").value.trim() });
  $("reqMsg").textContent = error ? "No se pudo enviar. Inténtalo de nuevo." : "Enviado. La coordinación revisará la guía docente y la añadirá si es posible.";
  if (!error) { $("reqText").value = ""; $("reqUrl").value = ""; }
});

/* ================= Accreditation proposals ================= */
const AUTO_PROPOSE_EVERY = 3;
let proposing = false, lastNoMatch = "";
const propuestas = () => perfil?.propuestas || [];
const nuevasLumen = () => propuestas().filter((p) => p.estado === "nueva" && p.origen === "lumen");

async function requestProposals(intencion) {
  if (proposing) return null;
  proposing = true;
  try {
    const { propuestas: list, sin_coincidencia } = await (await api("/api/analyze", { kind: "propose", intencion: intencion || "" })).json();
    perfil.propuestas = list;
    lastNoMatch = sin_coincidencia || "";
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
    const best = list?.find((p) => p.origen === "lumen");
    if (best) {
      bubble(`Mientras documentabas, he revisado tus ${evidences.length} evidencias. Encajan con «${best.asignatura}» (${best.titulacion}): ya cubres un ${best.encaje} %. ${best.motivo}`);
      choices(["Ver propuestas de acreditación"]);
    }
  } catch (e) { if (e.status === 429 || e.status === 403) aiState(false, e.message); /* 409: empty catalog, nothing to propose yet */ }
}
async function adoptProposal(id) {
  const p = propuestas().find((x) => x.id === id); if (!p) return;
  const a = catalogo.find((x) => x.id === p.asignatura_id && x.estado === "publicada");
  if (!a) throw new Error("Esa asignatura ya no está en el catálogo.");
  const list = propuestas().map((x) => ({ ...x, estado: x.id === id ? "adoptada" : x.estado === "adoptada" ? "nueva" : x.estado }));
  await updatePerfil({ propuestas: list });
  await setObjective(a, p.cobertura);
}
async function discardProposal(id) {
  await updatePerfil({ propuestas: propuestas().filter((x) => x.id !== id) });
  render();
}
function renderProposals() {
  const list = propuestas().filter((p) => p.asignatura_id);
  $("propBadge").hidden = !nuevasLumen().length; $("propBadge").textContent = nuevasLumen().length;
  if (!list.length) {
    $("propList").innerHTML = `<div class="empty">${evidences.length < 2 ? "Cuando tengas al menos dos evidencias, Lumen te propondrá acreditaciones por su cuenta. También puedes decirle arriba qué quieres acreditar." : "Aún no hay propuestas. Pulsa «Que Lumen proponga con mis evidencias» o di arriba qué quieres acreditar."}</div>`;
    return;
  }
  const evTitle = (id) => evidences.find((e) => e.id === id)?.titulo || "evidencia";
  $("propList").innerHTML = list.map((p) => {
    const covered = (p.cobertura || []).filter((c) => c.evidencias.length).length;
    return `<article class="prop${p.estado === "adoptada" ? " adoptada" : ""}">
      <div class="prop-head"><div style="min-width:0"><b>${safe(p.asignatura)}</b><small class="subtle">${safe(p.titulacion)} · ${safe(p.universidad)}${p.ects ? " · " + fmtN(p.ects) + " ECTS" : ""} · <a href="${safe(p.fuente_url)}" target="_blank" rel="noopener">guía docente oficial</a></small></div>
        <span class="pill ${p.estado === "adoptada" ? "ok" : p.origen === "usuario" ? "" : "warn"}">${p.estado === "adoptada" ? "Objetivo activo" : p.origen === "usuario" ? "Lo que pediste" : "Propuesta de Lumen"}</span></div>
      ${p.intencion ? `<p class="subtle">Pediste: «${safe(p.intencion)}»</p>` : ""}
      <div class="fit"><strong>${p.encaje} %</strong><div><span class="track" style="display:block"><span class="fill${p.encaje >= 70 ? " ok" : ""}" style="display:block;width:${p.encaje}%"></span></span>de encaje · ${covered} de ${p.resultados.length} resultados con evidencias</div></div>
      <p>${safe(p.motivo)}</p>
      <details class="more"><summary>Resultados de aprendizaje y qué los respalda</summary>
        <div class="ra-cover" style="margin-top:8px">${p.resultados.map((r) => { const ev = p.cobertura?.find((c) => c.resultado_id === r.id)?.evidencias || []; return `<div><span class="${ev.length ? "yes" : "no"}">${ev.length ? "✓" : "—"}</span><span><b>${safe(r.id)}</b> ${safe(r.texto)}${ev.length ? `<br><small class="subtle">${ev.map((id) => safe(evTitle(id))).join(" · ")}</small>` : ""}</span></div>`; }).join("")}</div>
      </details>
      ${p.siguientes_pasos?.length ? `<div><b style="font-size:13px">Para completarla</b><ul>${p.siguientes_pasos.map((x) => `<li>${safe(x)}</li>`).join("")}</ul></div>` : ""}
      ${p.estado === "adoptada" ? "" : `<div class="row-actions" style="margin-top:0"><button class="btn small accent" data-prop="adopt" data-id="${safe(p.id)}">Elegir esta acreditación</button><button class="btn small" data-prop="discard" data-id="${safe(p.id)}">Descartar</button></div>`}
    </article>`;
  }).join("");
}
$("propList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-prop]"); if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.prop === "adopt") { b.textContent = "Adoptando…"; await adoptProposal(b.dataset.id); $("intentMsg").textContent = "Acreditación elegida. Tus evidencias se han vinculado a sus resultados de aprendizaje oficiales."; }
    else await discardProposal(b.dataset.id);
  } catch (e) { b.disabled = false; $("intentMsg").textContent = e.message || "No se pudo guardar. Inténtalo de nuevo."; }
});
async function runProposal(intencion, btn) {
  const msg = $("intentMsg"), label = btn.textContent;
  if (!aiOk) { msg.textContent = "La IA no está disponible ahora mismo."; return; }
  btn.disabled = true; btn.textContent = "Analizando tus evidencias…"; msg.textContent = "";
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
const TITLES = { agente: ["Plataforma de evidencias de aprendizaje", "¿Qué has aprendido hoy?"], evidencias: ["Evidencias", "Cada aprendizaje, con sus pruebas."], objetivo: ["Acreditación", "¿Dónde puede contar lo que sabes?"], expediente: ["Expediente", "Lo que podrás presentar a la universidad."], coordinacion: ["Coordinación", "Seguimiento del piloto."], cuenta: ["Cuenta", "Tus datos, bajo tu control."] };
function show(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === id));
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === id));
  $("eyebrow").textContent = TITLES[id][0]; $("pagetitle").textContent = TITLES[id][1];
  if (id === "objetivo") renderCatalog();
  if (id === "cuenta") { $("aName").value = perfil.nombre || ""; $("aShare").checked = !!perfil.compartir_con_coordinacion; }
  if (id === "coordinacion") { loadPeople(); loadCoordCatalog(); }
  render(); window.scrollTo(0, 0);
}
document.querySelectorAll("[data-view]").forEach((x) => (x.onclick = () => show(x.dataset.view)));
document.querySelectorAll("[data-goto]").forEach((x) => (x.onclick = () => show(x.dataset.goto)));
document.querySelectorAll("[data-go-chat]").forEach((x) => (x.onclick = () => { show("agente"); if (!busy) { bubble("Quiero documentar algo nuevo.", "user"); begin(); } }));

let entered = false;
function enterApp() {
  showScreen("app");
  $("whoName").textContent = perfil.nombre || session.user.email;
  $("avatar").textContent = (perfil.nombre || session.user.email).split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  $("navCoord").hidden = perfil.role !== "coordinador";
  $("dDate").value = today();
  render();
  if (!entered) {
    entered = true;
    bubble(`Hola${perfil.nombre ? ", " + perfil.nombre.split(" ")[0] : ""}. Te ayudo a convertir lo que aprendes cada día en evidencias que una universidad pueda reconocer.\n\nCuéntame algo que hayas hecho o aprendido y te haré preguntas hasta tener lo que pide un expediente: qué sabes hacer, un caso real, horas, un producto que lo pruebe y alguien que pueda confirmarlo.\n\nSi ya sabes qué quieres acreditar, dímelo. Si no, a medida que documentes te iré proponiendo dónde puede contar lo que sabes.`);
    choices(["Empezar a documentar"]);
  }
}

/* ================= Render ================= */
function dots(v) { return `<span class="dots${v === 3 ? " full" : ""}">${[1, 2, 3].map((i) => `<i class="${i <= v ? "on" : ""}"></i>`).join("")}</span>`; }
function render() {
  if (!perfil) return;
  const sts = objetivo.resultados.map((r) => ({ r, s: outcomeStatus(r, evidences) }));
  const ready = sts.filter((x) => x.s.n === 5).length, h = totalHours(evidences), [e1, e2] = ectsRange(h);
  $("targetLine").textContent = objetivo.sinObjetivo ? "Aún no has elegido una asignatura del catálogo oficial." : `${objetivo.asignatura} · ${objetivo.titulacion} · ${objetivo.universidad}`;
  $("miniProgress").innerHTML = progressHtml(objetivo, evidences, { compact: true });
  $("kReady").textContent = `${ready}/${sts.length}`; $("kHours").textContent = fmtN(h); $("kEcts").textContent = h ? fmtN(e1) + "–" + fmtN(e2) : "0";
  $("raMini").innerHTML = sts.map(({ r, s }) => `<div title="${safe(r.texto)}"><b>${safe(r.id)}</b><span class="track"><span class="fill${s.n === 5 ? " ok" : ""}" style="display:block;width:${s.n * 20}%"></span></span><span class="subtle">${s.n}/5</span></div>`).join("");
  renderEvidenceList($("evidenceList"), evidences, objetivo, true);
  $("dossierTitle").textContent = objetivo.sinObjetivo ? "Expediente de reconocimiento" : "Expediente · " + objetivo.asignatura;
  $("dossierProgress").innerHTML = objetivo.sinObjetivo ? '<div class="empty">Elige una asignatura del catálogo oficial en «Acreditación» para construir tu expediente.</div>' : `<p class="note">${safe(objetivo.titulacion)} · ${safe(objetivo.universidad)} · <a href="${safe(objetivo.fuente_url)}" target="_blank" rel="noopener">guía docente oficial</a></p>${progressHtml(objetivo, evidences, { compact: true })}`;
  $("dossierKpis").innerHTML = kpisHtml(objetivo, evidences);
  $("dossierMatrix").innerHTML = matrixHtml(objetivo, evidences);
  renderMiAcreditacion();
  renderProposals();
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
function renderEvidenceList(container, evs, obj, editable) {
  const open = new Set([...container.querySelectorAll("details[open]")].map((d) => d.dataset.id));
  const rev = [...evs].reverse();
  if (!rev.length) { container.innerHTML = `<div class="empty">${editable ? "Aún no hay evidencias. Haz una entrevista o escribe en el diario rápido y aparecerán aquí con su valoración." : "Esta persona aún no tiene evidencias."}</div>`; return; }
  container.innerHTML = rev.map((e) => {
    const s = scoresOf(e), v = e.verificacion || {};
    const vPill = v.estado === "confirmada" ? '<span class="pill ok">Confirmada por tercero</span>' : v.estado === "solicitada" ? '<span class="pill warn">Confirmación solicitada</span>' : '<span class="pill">Sin confirmar</span>';
    const raTags = (e.resultados || []).map((id) => { const r = obj.resultados.find((x) => x.id === id); return `<span class="pill ra" title="${safe(r?.texto || "Este resultado ya no está en el objetivo")}">${safe(id)}</span>`; }).join("") || '<span class="pill">Sin resultado vinculado</span>';
    const texts = Object.entries(e.evidencias || {}).map(([k, t]) => `<p><strong>${safe(EV_LABELS[k] || k)}:</strong> ${safe(t)}</p>`).join("");
    const mat = e.material ? `<button class="pill" data-act="open" data-path="${safe(e.material.path)}" title="Contenido del que aprendió">📄 ${safe(e.material.name)}</button>` : "";
    const arts = mat + (e.artefactos || []).map((a) => `<button class="pill" data-act="open" data-path="${safe(a.path)}">📎 ${safe(a.name)}</button>`).join("");
    const verif = !editable && v.nombre ? `<p><strong>Confirmación:</strong> ${safe(v.nombre)}${v.rol ? " (" + safe(v.rol) + ")" : ""}${v.contacto ? " · " + safe(v.contacto) : ""} · ${safe(v.estado)}</p>` : "";
    const id = safe(e.id);
    return `<article class="card">
      <div class="card-head"><div style="min-width:0"><b>${safe(e.titulo)}</b><small>${e.tipo === "diario" ? "Diario" : "Entrevista"} · ${safe(fmtDate(e.fecha))}${e.contexto ? " · " + safe(e.contexto) : ""}${e.horas ? " · " + fmtN(num(e.horas)) + " h" : ""}</small></div>${vPill}</div>
      <div class="chips">${raTags}${arts}</div>
      <div class="vasc">${CRIT.map(([k, l]) => `<div>${l} ${s[k]}/3${dots(s[k])}</div>`).join("")}</div>
      ${e.falta ? `<div class="falta">Le falta: ${safe(e.falta)}</div>` : ""}
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
        <div class="field" style="margin-top:10px">Resultados de aprendizaje vinculados
          <div class="chips">${obj.resultados.map((r) => `<label class="pill ra" title="${safe(r.texto)}"><input type="checkbox" data-ra="${safe(r.id)}" data-ev="${id}"${(e.resultados || []).includes(r.id) ? " checked" : ""}> ${safe(r.id)}</label>`).join("")}</div>
        </div>
        <div class="edit-grid">
          <label class="field">Quién puede confirmarlo<input id="vn-${id}" value="${safe(v.nombre)}" placeholder="Nombre y apellidos"></label>
          <label class="field">Rol o relación<input id="vr-${id}" value="${safe(v.rol)}" placeholder="Ej.: responsable de equipo"></label>
          <label class="field">Contacto<input id="vc-${id}" value="${safe(v.contacto)}" placeholder="Correo o teléfono"></label>
          <label class="field">Estado de la confirmación<select id="vs-${id}">${["sin solicitar", "solicitada", "confirmada"].map((o) => `<option${o === v.estado ? " selected" : ""}>${o}</option>`).join("")}</select></label>
        </div>
        <div class="row-actions">
          <button class="btn small accent" data-act="save" data-id="${id}">Guardar cambios</button>
          <button class="btn small" data-act="copy" data-id="${id}">Copiar solicitud de confirmación</button>
          <label class="btn small" for="up-${id}">📎 Adjuntar producto o carta</label>
          <input type="file" id="up-${id}" data-act="upload" data-id="${id}" style="position:absolute;width:1px;height:1px;opacity:0">
          <button class="btn small danger" data-act="del" data-id="${id}">Eliminar</button>
          <span class="toast" id="msg-${id}"></span>
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
$("evidenceList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-act]"); if (!b || b.dataset.act === "open") return;
  const e = evidences.find((x) => x.id === b.dataset.id); if (!e) return;
  const msg = () => $("msg-" + e.id), say = (t) => { const m = msg(); if (m) m.textContent = t; };
  if (b.dataset.act === "save") {
    const n = structuredClone(e);
    n.titulo = $("t-" + e.id).value.trim() || e.titulo; n.fecha = $("f-" + e.id).value || e.fecha; n.horas = num($("h-" + e.id).value); n.contexto = $("c-" + e.id).value;
    n.resultados = [...document.querySelectorAll(`input[data-ev="${e.id}"]`)].filter((c) => c.checked).map((c) => c.dataset.ra);
    n.verificacion = { nombre: $("vn-" + e.id).value.trim(), rol: $("vr-" + e.id).value.trim(), contacto: $("vc-" + e.id).value.trim(), estado: $("vs-" + e.id).value };
    try { await saveEvidence(n); say("Guardado"); } catch (err) { say(err.message); }
  }
  if (b.dataset.act === "copy") {
    const t = verificationText(e);
    navigator.clipboard.writeText(t).then(() => say("Copiada. Envíala por correo y adjunta la respuesta como prueba.")).catch(() => { const cb = $("cb-" + e.id); cb.hidden = false; cb.value = t; cb.select(); say("Selecciona el texto y cópialo."); });
  }
  if (b.dataset.act === "del") {
    if (b.dataset.armed) { try { await deleteEvidence(e); } catch (err) { say(err.message); } return; }
    b.dataset.armed = "1"; b.textContent = "Pulsa otra vez para eliminar";
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Eliminar"; } }, 4000);
  }
});
$("evidenceList").addEventListener("change", async (ev) => {
  const inp = ev.target.closest('input[data-act="upload"]'); if (!inp) return;
  const f = inp.files?.[0], e = evidences.find((x) => x.id === inp.dataset.id); if (!f || !e) return;
  const say = (t) => { const m = $("msg-" + e.id); if (m) m.textContent = t; };
  say("Subiendo…");
  try {
    const a = await uploadFile(f, e.id), n = structuredClone(e);
    n.artefactos = [...(n.artefactos || []), a];
    await saveEvidence(n); say("Prueba adjuntada");
  } catch (err) { say(err.message); }
});

/* ================= Coordination ================= */
let people = [], selected = null;
async function loadPeople() {
  const { data, error } = await sb.from("perfiles").select("user_id,nombre,objetivo,compartir_con_coordinacion").neq("user_id", session.user.id).eq("compartir_con_coordinacion", true).order("nombre");
  if (error) { $("people").innerHTML = '<div class="empty">No se pudo cargar la lista.</div>'; return; }
  people = data;
  $("people").innerHTML = people.length ? people.map((p) => `<button class="person${selected?.user_id === p.user_id ? " on" : ""}" data-person="${safe(p.user_id)}"><span><b>${safe(p.nombre || "Sin nombre")}</b><br><small class="subtle">${safe(targetName(resolveObjetivo(p.objetivo)))}</small></span><span>→</span></button>`).join("") : '<div class="empty">Todavía nadie ha compartido su expediente.</div>';
}
$("people").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-person]"); if (!b) return;
  const p = people.find((x) => x.user_id === b.dataset.person); if (!p) return;
  const { data, error } = await sb.from("evidencias").select("data,created_at").eq("user_id", p.user_id).order("created_at");
  if (error) return;
  selected = { ...p, obj: resolveObjetivo(p.objetivo), evs: data.map((r) => r.data) };
  document.querySelectorAll(".person").forEach((x) => x.classList.toggle("on", x === b));
  $("coordDetail").hidden = false;
  $("coordName").textContent = p.nombre || "Sin nombre";
  $("coordProgress").innerHTML = `<p class="note">Acreditación: ${safe(targetName(selected.obj))}</p>${progressHtml(selected.obj, selected.evs)}`;
  $("coordKpis").innerHTML = kpisHtml(selected.obj, selected.evs);
  $("coordMatrix").innerHTML = matrixHtml(selected.obj, selected.evs);
  renderEvidenceList($("coordEvidences"), selected.evs, selected.obj, false);
  $("coordDetail").scrollIntoView({ behavior: "smooth" });
});
$("coordExport").onclick = () => selected && download(`lumen-expediente-${normalize(selected.nombre || "participante").replace(/\W+/g, "-")}.html`, dossierHtml(selected.obj, selected.evs, selected.nombre), "text/html");

/* ================= Coordination: official catalog ================= */
let solicitudes = [];
async function loadCoordCatalog() {
  if (perfil.role !== "coordinador") return;
  const [, r] = await Promise.all([loadCatalog(), sb.from("solicitudes_catalogo").select("*").order("created_at", { ascending: false })]);
  solicitudes = r.data || [];
  renderCoordCatalog();
}
function renderCoordCatalog() {
  const label = { publicada: ["ok", "Publicada"], borrador: ["warn", "Borrador"], retirada: ["", "Retirada"] };
  $("catAdmin").innerHTML = catalogo.length ? catalogo.map((a) => `<div class="cat-row"><div style="min-width:0"><b>${safe(a.asignatura)}</b><small>${safe(a.titulacion)} · ${safe(a.universidad)} · ${fmtN(Number(a.ects))} ECTS · ${a.resultados.length} RA · <a href="${safe(a.fuente_url)}" target="_blank" rel="noopener">fuente</a></small></div>
    <div class="row-actions" style="margin-top:0"><span class="pill ${label[a.estado][0]}">${label[a.estado][1]}</span><button class="btn small" data-cat="edit" data-id="${safe(a.id)}">Editar</button>${a.estado === "publicada" ? `<button class="btn small" data-cat="retirada" data-id="${safe(a.id)}">Retirar</button>` : `<button class="btn small accent" data-cat="publicada" data-id="${safe(a.id)}">Publicar</button>`}</div></div>`).join("")
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
$("accountForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try { await updatePerfil({ nombre: $("aName").value.trim(), compartir_con_coordinacion: $("aShare").checked }); $("aToast").textContent = "Guardado"; enterApp(); }
  catch { $("aToast").textContent = "No se pudo guardar."; }
});
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
<p><b>Valoración preliminar:</b> validez ${s.validez}/3 · autenticidad ${s.autenticidad}/3 · suficiencia ${s.suficiencia}/3 · vigencia ${s.vigencia}/3</p>
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
$("exportHtml").onclick = () => download("lumen-expediente.html", dossierHtml(objetivo, evidences, perfil.nombre), "text/html");
$("exportJson").onclick = () => download("lumen-mis-datos.json", JSON.stringify({ plataforma: "Lumen", exportado: new Date().toISOString(), aviso: "Declaraciones autoinformadas, pendientes de evaluación por la universidad", perfil: { nombre: perfil.nombre, consentimiento_at: perfil.consentimiento_at, compartir_con_coordinacion: perfil.compartir_con_coordinacion, objetivo }, evidencias: evidences }, null, 2), "application/json");

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
$("consentForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!$("cAccept").checked) { $("consentError").textContent = "Para participar tienes que aceptar la información sobre protección de datos."; return; }
  try {
    await updatePerfil({ nombre: $("cName").value.trim(), consentimiento_at: new Date().toISOString(), consentimiento_version: CONSENT_VERSION, compartir_con_coordinacion: $("cShare").checked });
    route();
  } catch { $("consentError").textContent = "No se pudo guardar. Inténtalo de nuevo."; }
});

/* ================= Composer: attach and dictate ================= */
$("chatFile").addEventListener("change", (ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; if (f) attachSource(f); });
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
