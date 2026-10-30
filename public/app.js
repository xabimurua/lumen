"use strict";
const $ = (id) => document.getElementById(id);
const MAX_TURNS = 7, HOURS_PER_ECTS_MIN = 25, HOURS_PER_ECTS_MAX = 30, VIGENCIA_YEARS = 5;
const CONSENT_VERSION = "piloto-v1";
const BUCKET = "artefactos";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const GENERIC_RA = [
  { id: "C1", texto: "Analiza críticamente información y argumentos, identificando evidencias, sesgos y límites." },
  { id: "C2", texto: "Utiliza tecnologías digitales y datos de forma reflexiva, eficaz y ética." },
  { id: "C3", texto: "Comunica ideas complejas con claridad, de forma oral y escrita, a públicos diversos." },
  { id: "C4", texto: "Participa en contextos sociales y ciudadanos con criterio y responsabilidad." },
  { id: "C5", texto: "Planifica y gestiona proyectos, y coordina o lidera equipos." },
];
const GENERIC_OBJ = { universidad: "", titulacion: "", asignatura: "", ects: "", resultados: GENERIC_RA, generico: true };
const GENERIC_KEYS = { C1: ["critica", "argument", "evidencia", "sesgo", "cuestion", "razon", "analiz"], C2: ["inteligencia artificial", "algoritmo", "automat", "tecnolog", "datos", "excel", "programa", "digital"], C3: ["dialog", "escucha", "comunic", "narrativ", "explicar", "present", "escrib"], C4: ["democr", "particip", "ciudadan", "deliber", "social", "comunidad", "voluntari"], C5: ["lider", "equipo", "gestion", "proyecto", "estrateg", "planific", "coordin"] };
const EV_LABELS = { idea: "Qué aprendió", aplicacion: "Aplicación", argumentacion: "Argumentación", conexion: "Conexión con su experiencia", limites: "Límites y dudas", sintesis: "Síntesis final", texto: "Registro del diario" };
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
let sb = null, session = null, perfil = null, objetivo = GENERIC_OBJ, evidences = [];

function showScreen(name) {
  for (const [id, n] of [["sLoading", "loading"], ["sLogin", "login"], ["sSent", "sent"], ["sConsent", "consent"], ["sApp", "app"]]) $(id).hidden = n !== name;
}

async function boot() {
  try {
    const cfg = await fetch("/api/config").then((r) => { if (!r.ok) throw new Error(); return r.json(); });
    sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" } });
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
    await loadEvidences();
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
  objetivo = perfil.objetivo?.resultados?.length ? perfil.objetivo : GENERIC_OBJ;
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
async function uploadFile(file, evidenceId) {
  if (file.size > MAX_FILE_BYTES) throw new Error("El archivo supera los 25 MB.");
  const clean = file.name.normalize("NFD").replace(/[^\w.-]+/g, "_").slice(-80);
  const path = `${session.user.id}/${evidenceId}/${Date.now()}-${clean}`;
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
const targetName = (obj) => (obj.generico ? "competencias transversales (genérico)" : [obj.asignatura, obj.titulacion, obj.universidad].filter(Boolean).join(" · ") || "sin definir");

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
  const n = " " + normalize(text) + " ";
  if (objetivo.generico) return Object.entries(GENERIC_KEYS).filter(([, keys]) => keys.some((w) => n.includes(w))).map(([id]) => id);
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
function begin(seed) {
  draft = { id: uid(), titulo: "", fuente: "", url: "", turns: [], used: [], history: [], createdAt: Date.now() };
  if (seed) { draft.titulo = seed; stage = "dialogue"; ask(`Vamos a documentar «${seed}». Cuéntame con tus palabras qué aprendiste y en qué situación.`); return; }
  stage = "type";
  ask("¿Qué quieres hacer hoy? Puedes documentar algo que hayas aprendido (una tarea del trabajo, un proyecto, un voluntariado, un curso o algo que resolviste en tu vida diaria) o decirme qué te gustaría acreditar.", ["Una tarea de mi trabajo", "Un proyecto que llevé", "Un voluntariado", "Un curso, libro o podcast", "Quiero acreditar algo concreto"]);
}
function setBusy(b) { busy = b; $("send").disabled = b; }

async function agentTurn(userText, { closing = false } = {}) {
  const el = bubble("Pensando…"); el.classList.add("thinking"); setPhase(); setBusy(true);
  try {
    if (!aiOk) throw new Error("offline");
    const r = await api("/api/chat", { titulo: draft.titulo, history: draft.history, closing });
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
      const p = list?.find((x) => x.origen === "usuario") || list?.[0];
      el.classList.remove("thinking");
      el.textContent = p ? `Te propongo como objetivo «${p.asignatura}» (${p.titulacion}${p.ects ? ", " + fmtN(p.ects) + " ECTS" : ""}). Con lo que has documentado, cubres un ${p.encaje} %. ${p.motivo}${p.siguientes_pasos?.[0] ? "\n\nPrimer paso: " + p.siguientes_pasos[0] : ""}` : "No he podido preparar una propuesta. Inténtalo desde «Acreditación».";
      stage = "done"; setPhase(); choices(["Ver propuestas de acreditación", "Documentar otra cosa"]);
    } catch (e) {
      el.classList.remove("thinking"); el.textContent = e.message + " Puedes definir el objetivo a mano en «Acreditación».";
      stage = "done"; choices(["Ver propuestas de acreditación", "Documentar otra cosa"]);
    } finally { setBusy(false); }
    return;
  }
  if (stage === "type") {
    if (/^(una tarea de mi trabajo|un proyecto que lleve|un voluntariado|un curso, libro o podcast)$/.test(normalize(value))) {
      draft.fuente = value; stage = "titleAsk"; ask("Perfecto. Descríbelo en una frase: ¿qué era y qué hiciste tú?"); return;
    }
    draft.titulo = value; const m = value.match(/https?:\/\/\S+/); if (m) draft.url = m[0];
    stage = "dialogue"; ask(`Vamos a documentar «${value}». Cuéntame con tus palabras qué aprendiste y en qué situación.`); return;
  }
  if (stage === "titleAsk") { draft.titulo = value; stage = "dialogue"; ask("Gracias. ¿Qué aprendiste exactamente y qué hiciste tú, en primera persona?"); return; }
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
    const o = await (await api("/api/analyze", { kind: "interview", titulo: draft.titulo, history: draft.history })).json();
    const ev = {}; for (const k of ["idea", "aplicacion", "argumentacion", "conexion", "limites"]) if (o.evidencias?.[k]?.trim()) ev[k] = o.evidencias[k].trim();
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
    id: draft.id, kind: "evidence", tipo: "entrevista", titulo: r.titulo || draft.titulo, fuente: draft.fuente, url: draft.url,
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

/* ================= Objective ================= */
function fillProfileForm() {
  $("pUni").value = objetivo.universidad || ""; $("pTit").value = objetivo.titulacion || ""; $("pAsig").value = objetivo.asignatura || ""; $("pEcts").value = objetivo.ects || "";
  $("pRA").value = objetivo.resultados.map((r) => r.texto).join("\n");
}
$("profileForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const lines = $("pRA").value.split("\n").map((s) => s.replace(/^\s*(RA\s*\d+|C\d+|[-•*\d.)]+)\s*[:.)-]?\s*/i, "").trim()).filter(Boolean);
  if (!lines.length) { $("pToast").textContent = "Añade al menos un resultado de aprendizaje."; return; }
  const prev = new Map(objetivo.resultados.map((r) => [normalize(r.texto), r.id]));
  const taken = new Set(prev.values()), used = new Set(); let next = 1;
  const resultados = lines.map((t) => {
    let id = prev.get(normalize(t));
    if (!id || used.has(id)) { while (taken.has("RA" + next) || used.has("RA" + next)) next++; id = "RA" + next; }
    used.add(id); return { id, texto: t };
  });
  const generico = resultados.every((r) => GENERIC_RA.some((g) => g.id === r.id && g.texto === r.texto)) && !$("pTit").value.trim() && !$("pAsig").value.trim();
  const changedRA = JSON.stringify(resultados) !== JSON.stringify(objetivo.resultados);
  const obj = { universidad: $("pUni").value.trim(), titulacion: $("pTit").value.trim(), asignatura: $("pAsig").value.trim(), ects: $("pEcts").value, resultados, generico, fuente: changedRA || objetivo.fuente !== "propuesta" ? "guia" : "propuesta" };
  try {
    await updatePerfil({ objetivo: obj });
    objetivo = obj; fillProfileForm(); render();
    $("pToast").textContent = "Objetivo guardado. Las próximas entrevistas se orientarán a estos resultados.";
  } catch { $("pToast").textContent = "No se pudo guardar. Inténtalo de nuevo."; }
});
$("pGeneric").onclick = () => { $("pRA").value = GENERIC_RA.map((r) => r.texto).join("\n"); $("pToast").textContent = "Pulsa «Guardar objetivo» para aplicarlo."; };
$("pExtract").onclick = async () => {
  const g = $("pGuide").value.trim(), msg = $("pExtractMsg");
  if (!g) { msg.textContent = "Pega primero el texto de la guía docente."; return; }
  $("pExtract").disabled = true; msg.textContent = "Extrayendo…";
  try {
    const { resultados } = await (await api("/api/analyze", { kind: "extract", guia: g })).json();
    if (resultados.length) { $("pRA").value = resultados.join("\n"); msg.textContent = `${resultados.length} resultados extraídos. Revísalos y pulsa «Guardar objetivo».`; }
    else msg.textContent = "No encontré resultados en ese texto. Prueba con el apartado de competencias.";
  } catch (e) { msg.textContent = e.message || "No se pudo extraer. Cópialos a mano, uno por línea."; }
  finally { $("pExtract").disabled = false; }
};

/* ================= Accreditation proposals ================= */
const AUTO_PROPOSE_EVERY = 3;
let proposing = false;
const propuestas = () => perfil?.propuestas || [];
const nuevasLumen = () => propuestas().filter((p) => p.estado === "nueva" && p.origen === "lumen");

async function requestProposals(intencion) {
  if (proposing) return null;
  proposing = true;
  try {
    const { propuestas: list } = await (await api("/api/analyze", { kind: "propose", intencion: intencion || "" })).json();
    perfil.propuestas = list;
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
  } catch (e) { if (e.status === 429 || e.status === 403) aiState(false, e.message); }
}
async function adoptProposal(id) {
  const p = propuestas().find((x) => x.id === id); if (!p) return;
  const obj = { universidad: "", titulacion: p.titulacion, asignatura: p.asignatura, ects: String(p.ects || ""), resultados: p.resultados, generico: false, fuente: "propuesta", propuesta_id: p.id };
  const list = propuestas().map((x) => ({ ...x, estado: x.id === id ? "adoptada" : x.estado === "adoptada" ? "nueva" : x.estado }));
  await updatePerfil({ objetivo: obj, propuestas: list });
  objetivo = obj;
  // Re-link every evidence to the adopted outcomes, following the proposal's coverage map.
  const byEv = new Map();
  for (const c of p.cobertura || []) for (const ev of c.evidencias) byEv.set(ev, [...(byEv.get(ev) || []), c.resultado_id]);
  for (const e of evidences) {
    const next = byEv.get(e.id) || [];
    if (JSON.stringify(next) !== JSON.stringify(e.resultados || [])) await saveEvidence({ ...structuredClone(e), resultados: next });
  }
  render(); fillProfileForm();
}
async function discardProposal(id) {
  await updatePerfil({ propuestas: propuestas().filter((x) => x.id !== id) });
  render();
}
function renderProposals() {
  const list = propuestas();
  $("propBadge").hidden = !nuevasLumen().length; $("propBadge").textContent = nuevasLumen().length;
  if (!list.length) {
    $("propList").innerHTML = `<div class="empty">${evidences.length < 2 ? "Cuando tengas al menos dos evidencias, Lumen te propondrá acreditaciones por su cuenta. También puedes decirle arriba qué quieres acreditar." : "Aún no hay propuestas. Pulsa «Que Lumen proponga con mis evidencias» o di arriba qué quieres acreditar."}</div>`;
    return;
  }
  const evTitle = (id) => evidences.find((e) => e.id === id)?.titulo || "evidencia";
  $("propList").innerHTML = list.map((p) => {
    const covered = (p.cobertura || []).filter((c) => c.evidencias.length).length;
    return `<article class="prop${p.estado === "adoptada" ? " adoptada" : ""}">
      <div class="prop-head"><div style="min-width:0"><b>${safe(p.asignatura)}</b><small class="subtle">${safe(p.tipo)} · ${safe(p.titulacion)}${p.ects ? " · " + fmtN(p.ects) + " ECTS" : ""}</small></div>
        <span class="pill ${p.estado === "adoptada" ? "ok" : p.origen === "usuario" ? "" : "warn"}">${p.estado === "adoptada" ? "Objetivo activo" : p.origen === "usuario" ? "Lo que pediste" : "Propuesta de Lumen"}</span></div>
      ${p.intencion ? `<p class="subtle">Pediste: «${safe(p.intencion)}»</p>` : ""}
      <div class="fit"><strong>${p.encaje} %</strong><div><span class="track" style="display:block"><span class="fill${p.encaje >= 70 ? " ok" : ""}" style="display:block;width:${p.encaje}%"></span></span>de encaje · ${covered} de ${p.resultados.length} resultados con evidencias</div></div>
      <p>${safe(p.motivo)}</p>
      <details class="more"><summary>Resultados de aprendizaje y qué los respalda</summary>
        <div class="ra-cover" style="margin-top:8px">${p.resultados.map((r) => { const ev = p.cobertura?.find((c) => c.resultado_id === r.id)?.evidencias || []; return `<div><span class="${ev.length ? "yes" : "no"}">${ev.length ? "✓" : "—"}</span><span><b>${safe(r.id)}</b> ${safe(r.texto)}${ev.length ? `<br><small class="subtle">${ev.map((id) => safe(evTitle(id))).join(" · ")}</small>` : ""}</span></div>`; }).join("")}</div>
      </details>
      ${p.siguientes_pasos?.length ? `<div><b style="font-size:13px">Para completarla</b><ul>${p.siguientes_pasos.map((x) => `<li>${safe(x)}</li>`).join("")}</ul></div>` : ""}
      ${p.estado === "adoptada" ? "" : `<div class="row-actions" style="margin-top:0"><button class="btn small accent" data-prop="adopt" data-id="${safe(p.id)}">Adoptar como objetivo</button><button class="btn small" data-prop="discard" data-id="${safe(p.id)}">Descartar</button></div>`}
    </article>`;
  }).join("");
}
$("propList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-prop]"); if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.prop === "adopt") { b.textContent = "Adoptando…"; await adoptProposal(b.dataset.id); $("intentMsg").textContent = "Objetivo adoptado. Tus evidencias se han vinculado a sus resultados."; }
    else await discardProposal(b.dataset.id);
  } catch { b.disabled = false; $("intentMsg").textContent = "No se pudo guardar. Inténtalo de nuevo."; }
});
async function runProposal(intencion, btn) {
  const msg = $("intentMsg"), label = btn.textContent;
  if (!aiOk) { msg.textContent = "La IA no está disponible ahora mismo."; return; }
  btn.disabled = true; btn.textContent = "Analizando tus evidencias…"; msg.textContent = "";
  try {
    const list = await requestProposals(intencion);
    msg.textContent = list?.length ? "Propuestas actualizadas." : "No he encontrado propuestas.";
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
  if (id === "objetivo") fillProfileForm();
  if (id === "cuenta") { $("aName").value = perfil.nombre || ""; $("aShare").checked = !!perfil.compartir_con_coordinacion; }
  if (id === "coordinacion") loadPeople();
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
  $("targetLine").textContent = "Objetivo: " + targetName(objetivo) + (objetivo.fuente === "propuesta" ? " (propuesto por Lumen)" : "");
  $("kReady").textContent = `${ready}/${sts.length}`; $("kHours").textContent = fmtN(h); $("kEcts").textContent = h ? fmtN(e1) + "–" + fmtN(e2) : "0";
  $("raMini").innerHTML = sts.map(({ r, s }) => `<div title="${safe(r.texto)}"><b>${safe(r.id)}</b><span class="track"><span class="fill${s.n === 5 ? " ok" : ""}" style="display:block;width:${s.n * 20}%"></span></span><span class="subtle">${s.n}/5</span></div>`).join("");
  renderEvidenceList($("evidenceList"), evidences, objetivo, true);
  $("dossierTitle").textContent = objetivo.generico ? "Expediente de reconocimiento" : "Expediente · " + (objetivo.asignatura || objetivo.titulacion);
  $("dossierKpis").innerHTML = kpisHtml(objetivo, evidences);
  $("dossierMatrix").innerHTML = matrixHtml(objetivo, evidences);
  $("objWarn").innerHTML = objetivo.fuente === "propuesta" ? '<p class="falta">Estos resultados de aprendizaje los propuso Lumen. Cuando tengas la guía docente real, pégala abajo para sustituirlos por los oficiales.</p>' : "";
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
    const arts = (e.artefactos || []).map((a) => `<button class="pill" data-act="open" data-path="${safe(a.path)}">📎 ${safe(a.name)}</button>`).join("");
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
  $("people").innerHTML = people.length ? people.map((p) => `<button class="person${selected?.user_id === p.user_id ? " on" : ""}" data-person="${safe(p.user_id)}"><span><b>${safe(p.nombre || "Sin nombre")}</b><br><small class="subtle">${safe(targetName(p.objetivo?.resultados?.length ? p.objetivo : GENERIC_OBJ))}</small></span><span>→</span></button>`).join("") : '<div class="empty">Todavía nadie ha compartido su expediente.</div>';
}
$("people").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-person]"); if (!b) return;
  const p = people.find((x) => x.user_id === b.dataset.person); if (!p) return;
  const { data, error } = await sb.from("evidencias").select("data,created_at").eq("user_id", p.user_id).order("created_at");
  if (error) return;
  selected = { ...p, obj: p.objetivo?.resultados?.length ? p.objetivo : GENERIC_OBJ, evs: data.map((r) => r.data) };
  document.querySelectorAll(".person").forEach((x) => x.classList.toggle("on", x === b));
  $("coordDetail").hidden = false;
  $("coordName").textContent = p.nombre || "Sin nombre";
  $("coordTarget").textContent = "Objetivo: " + targetName(selected.obj);
  $("coordKpis").innerHTML = kpisHtml(selected.obj, selected.evs);
  $("coordMatrix").innerHTML = matrixHtml(selected.obj, selected.evs);
  renderEvidenceList($("coordEvidences"), selected.evs, selected.obj, false);
  $("coordDetail").scrollIntoView({ behavior: "smooth" });
});
$("coordExport").onclick = () => selected && download(`lumen-expediente-${normalize(selected.nombre || "participante").replace(/\W+/g, "-")}.html`, dossierHtml(selected.obj, selected.evs, selected.nombre), "text/html");

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
<table><tr><th>Solicitante</th><td>${safe(nombre || "—")}</td></tr><tr><th>Universidad</th><td>${safe(obj.universidad || "—")}</td></tr><tr><th>Titulación</th><td>${safe(obj.titulacion || "—")}</td></tr><tr><th>Asignatura o módulo</th><td>${safe(obj.asignatura || "—")}${obj.ects ? " (" + safe(obj.ects) + " ECTS)" : ""}</td></tr>
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

/* ================= Composer ================= */
function respond() { const v = $("answer").value; if (v.trim()) submit(v); }
$("send").onclick = respond;
$("answer").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); respond(); } });

boot();
