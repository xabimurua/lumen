// Claude calls: the interview turn (streamed) and structured analyses (JSON).
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { HttpError } from "./server.js";

export const MODEL = process.env.LUMEN_MODEL || "claude-opus-5-5";
const BETAS = ["server-side-fallback-2026-07-01"];
// Organisation-level API keys must say which workspace to bill; workspace keys don't need this.
const WORKSPACE = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
const client = new Anthropic(WORKSPACE ? { defaultHeaders: { "anthropic-workspace-id": WORKSPACE } } : {});

export const CONTEXTOS = ["Trabajo", "Voluntariado", "Formación no reglada", "Vida diaria / autodidacta"];

function objetivoText(obj) {
  const nombre = !obj?.resultados?.length
    ? "todavía sin elegir (aún no ha escogido una asignatura del catálogo oficial)"
    : obj?.generico
    ? "competencias transversales (genérico)"
    : [obj?.asignatura, obj?.titulacion, obj?.universidad].filter(Boolean).join(" · ") || "sin definir";
  const ras = (obj?.resultados || []).map((r) => `${r.id}: ${r.texto}`).join("\n");
  return { nombre, ras };
}

export function interviewSystem(obj) {
  const { nombre, ras } = objetivoText(obj);
  return `Eres Lumen, un agente que entrevista a una persona para sacar evidencias de lo que ha aprendido en su día a día (trabajo, voluntariado, formación no reglada, vida diaria), de modo que una universidad pueda valorarlas para reconocerle créditos.

Objetivo de acreditación: ${nombre}.
Resultados de aprendizaje del objetivo:
${ras}

CÓMO PREGUNTAR
Cada pregunta nace de algo concreto: una idea, un dato, un apartado o un término del contenido que la persona ha aportado, o una frase literal de su última respuesta. Nómbralo en la pregunta. Nunca hagas preguntas genéricas que valdrían para cualquier tema.
Avanza por estos escalones y no subas al siguiente hasta tener una respuesta sólida en el anterior:
1. Comprensión: que explique con sus palabras una idea clave del contenido o de su experiencia, y por qué importa.
2. Aplicación: un caso real suyo en el que lo usó. Qué hizo exactamente, qué decidió y con qué criterio, qué resultado obtuvo.
3. Análisis: qué habría pasado de otra manera, qué alternativa descartó, en qué condiciones no funcionaría.
4. Valoración: qué límites tiene lo aprendido, qué le falta por dominar, qué haría distinto.
QUÉ HACER SEGÚN EL CONTENIDO
- Si hay un documento o una página adjunta con su texto, ancla las preguntas en sus ideas concretas.
- Si solo tienes el título y el autor (un vídeo de YouTube, un pódcast de Spotify, una página que no se pudo leer) o la persona solo nombra un libro, artículo o curso, puedes apoyarte en lo que sepas de esa obra, pero con prudencia: si no estás seguro de un detalle, no lo afirmes. En tu primera pregunta, pide a la persona que te cuente la idea que más le marcó, y construye a partir de lo que diga.
- Si lo que aprendió viene de su trabajo o de un proyecto, el contenido es su propia experiencia: ancla las preguntas en las tareas y decisiones que describa.
- Si tienes una ficha de contexto buscada en internet, úsala para hacer preguntas informadas (por ejemplo, sobre un hito, una cifra o una decisión del proyecto que aparece en las fuentes), sin recitarla. Pide a la persona que concrete qué hizo ella exactamente: la ficha describe el proyecto, no su aportación.
Si una respuesta es vaga, pide el detalle que falta (un ejemplo, una cifra, un paso concreto) antes de seguir. Si contradice el contenido o es inexacta, pregúntale cómo encaja con lo que dice el material, sin corregirle tú. Si dice que no sabe, baja un escalón y ayúdale a anclarse en lo que sí sabe.

DATOS QUE DEBE TENER EL EXPEDIENTE
Cuando encajen de forma natural, sin convertirlo en un formulario, consigue también: el contexto, una fecha aproximada y las horas dedicadas; un producto verificable que pueda adjuntar (documento, informe, código, material); y quién podría confirmarlo (nombre y rol).
Orienta todo hacia los resultados de aprendizaje oficiales con los que encaja lo que cuenta. Si nada encaja, díselo con tacto y busca la conexión más honesta. Si todavía no ha elegido una asignatura del catálogo, recoge evidencias sólidas igualmente: Lumen le propondrá después asignaturas oficiales donde pueden contar.

ESTILO
Español. Tono cálido y exigente. En cada turno, como mucho una frase que recoja algo concreto de lo que dijo y después UNA sola pregunta abierta. Sin listas ni markdown. Máximo 70 palabras. No expliques ni resumas el contenido por la persona: la evidencia tiene que salir de ella. No prometas créditos ni digas que certificas nada.`;
}

const CLOSING =
  "Cierra la entrevista: pide a la persona que formule en dos o tres frases lo que ahora sabe hacer, la prueba que mejor lo demuestra y lo que aún le falta. Dile que si prefiere seguir profundizando escriba «seguir».";

const HistorySchema = z
  .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(6000) }))
  .min(1)
  .max(40)
  .refine((h) => h[0].role === "user" && h.at(-1).role === "user", "La conversación debe empezar y terminar con la persona.");

export function parseHistory(raw) {
  const r = HistorySchema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "La conversación enviada no es válida.");
  return r.data;
}

/** Streams the next interviewer turn as plain text chunks to `onText`. `fuente` is an optional document block. */
export async function streamInterviewTurn({ objetivo, titulo, history, closing, fuente, contexto, onText }) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const intro = `Lo que quiero documentar: «${titulo}».${fuente ? " Te adjunto el contenido del que aprendí: basa tus preguntas en él." : ""}${contexto ? " También tienes una ficha de contexto que Lumen buscó en internet sobre lo que menciono: úsala para preguntar con conocimiento de causa, pero no la tomes como prueba de lo que yo hice y, si algo no te cuadra, pregúntame." : ""}\n\n${messages[0].content}`;
  const docs = [fuente, contexto].filter(Boolean);
  messages[0] = { role: "user", content: docs.length ? [...docs, { type: "text", text: intro }] : intro };
  if (closing) messages.push({ role: "system", content: CLOSING });

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: [{ type: "text", text: interviewSystem(objetivo), cache_control: { type: "ephemeral" } }],
    messages,
  });
  stream.on("text", (delta) => onText(delta));
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") throw new HttpError(422, "No he podido continuar con esa respuesta. Reformúlala, por favor.");
  return final.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

async function jsonCall({ prompt, schema, validator, effort = "medium", fuente = null, contexto = null }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: fuente || contexto ? [fuente, contexto].filter(Boolean).concat({ type: "text", text: prompt }) : prompt }],
  });
  if (response.stop_reason === "refusal") throw new HttpError(422, "La IA no pudo analizar este contenido.");
  if (response.stop_reason === "max_tokens") throw new HttpError(502, "La respuesta de la IA quedó incompleta. Inténtalo de nuevo.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(502, "La IA devolvió un formato inesperado. Inténtalo de nuevo.");
  }
  const r = validator.safeParse(parsed);
  if (!r.success) throw new HttpError(502, "La IA devolvió un formato inesperado. Inténtalo de nuevo.");
  return r.data;
}

const str = { type: "string" };
const score = { type: "integer", description: "De 0 a 3" };

export async function analyzeInterview({ objetivo, titulo, history, today, fuente = null, contexto = null }) {
  const { ras } = objetivoText(objetivo);
  const ids = (objetivo?.resultados || []).map((r) => r.id);
  const transcript = history.map((m) => `${m.role === "user" ? "Persona" : "Lumen"}: ${m.content}`).join("\n");
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["titulo", "evidencias", "resultados", "validez", "suficiencia", "contexto", "horas", "fecha", "verificador_nombre", "verificador_rol", "falta"],
    properties: {
      titulo: str,
      evidencias: {
        type: "object",
        additionalProperties: false,
        required: ["idea", "aplicacion", "argumentacion", "conexion", "limites", "fidelidad"],
        properties: { idea: str, aplicacion: str, argumentacion: str, conexion: str, limites: str, fidelidad: str },
      },
      resultados: { type: "array", items: { type: "string", enum: ids.length ? ids : ["-"] } },
      validez: score,
      suficiencia: score,
      contexto: { type: "string", enum: [...CONTEXTOS, ""] },
      horas: { type: "number" },
      fecha: { type: "string", description: "AAAA-MM-DD, o cadena vacía si no se dijo" },
      verificador_nombre: str,
      verificador_rol: str,
      falta: str,
    },
  };
  const validator = z.object({
    titulo: z.string(),
    evidencias: z.object({ idea: z.string(), aplicacion: z.string(), argumentacion: z.string(), conexion: z.string(), limites: z.string(), fidelidad: z.string() }),
    resultados: z.array(z.string()),
    validez: z.number(),
    suficiencia: z.number(),
    contexto: z.string(),
    horas: z.number(),
    fecha: z.string(),
    verificador_nombre: z.string(),
    verificador_rol: z.string(),
    falta: z.string(),
  });
  const out = await jsonCall({
    schema,
    validator,
    fuente,
    contexto,
    prompt: `Analiza esta entrevista para un expediente de reconocimiento académico de aprendizajes por experiencia. Usa solo lo que dijo la persona y no inventes nada.${fuente ? " La persona adjuntó el documento de arriba como contenido del que aprendió: úsalo solo para comprobar si sus explicaciones son fieles a él, nunca como evidencia de lo que ella sabe." : ""}${contexto ? " También hay una ficha de contexto buscada en internet: sirve solo para entender de qué habla; lo que la persona hizo solo lo prueba lo que ella cuenta." : ""}

Resultados de aprendizaje disponibles:
${ras}

- titulo: nombre breve y descriptivo de la evidencia (máximo 8 palabras).
- evidencias: una o dos frases en tercera persona por apartado, parafraseando a la persona; cadena vacía si no hay evidencia para ese apartado.
- evidencias.fidelidad: ${fuente ? "una o dos frases sobre si lo que explicó la persona es fiel al contenido adjunto: qué entendió bien y qué explicó de forma inexacta o incompleta" : "cadena vacía (no hay contenido adjunto)"}.
- resultados: solo los ID a los que esta evidencia aporte de verdad (de 0 a 3).
- validez (0-3): grado en que lo contado demuestra esos resultados${fuente ? "; baja la puntuación si sus explicaciones contradicen el contenido" : ""}. suficiencia (0-3): profundidad (explica, aplica con un caso, da resultados, reconoce límites).
- horas: las que dijo la persona, 0 si no lo dijo. fecha: la que dijo, o cadena vacía. contexto: uno de los cuatro, o cadena vacía.
- verificador_nombre y verificador_rol: la persona que podría confirmarlo, o cadenas vacías.
- falta: una frase concreta sobre qué debe añadir para que la evidencia sea suficiente para una universidad.
Hoy es ${today}.

Entrevista sobre «${titulo}»:
${transcript}`,
  });
  return { ...out, resultados: out.resultados.filter((id) => ids.includes(id)).slice(0, 3) };
}

export async function linkDiary({ objetivo, texto, contexto, horas }) {
  const { ras } = objetivoText(objetivo);
  const ids = (objetivo?.resultados || []).map((r) => r.id);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["titulo", "resultados", "validez", "suficiencia", "falta"],
    properties: {
      titulo: str,
      resultados: { type: "array", items: { type: "string", enum: ids.length ? ids : ["-"] } },
      validez: score,
      suficiencia: score,
      falta: str,
    },
  };
  const validator = z.object({ titulo: z.string(), resultados: z.array(z.string()), validez: z.number(), suficiencia: z.number(), falta: z.string() });
  const out = await jsonCall({
    schema,
    validator,
    effort: "low",
    prompt: `Vincula esta entrada del diario de aprendizaje con resultados de aprendizaje universitarios. Usa solo lo escrito.

Resultados:
${ras}

Entrada (${contexto}, ${horas} h): «${texto}»

titulo: máximo 8 palabras. resultados: de 0 a 3 ID que encajen de verdad. validez y suficiencia: de 0 a 3. falta: una frase con lo que falta para que sea una evidencia suficiente.`,
  });
  return { ...out, resultados: out.resultados.filter((id) => ids.includes(id)).slice(0, 3) };
}

export async function extractOutcomes(guia) {
  const out = await jsonCall({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["resultados"],
      properties: { resultados: { type: "array", items: str } },
    },
    validator: z.object({ resultados: z.array(z.string()) }),
    effort: "low",
    prompt: `De este texto de una guía docente universitaria, extrae los resultados de aprendizaje (o, si no los hay, las competencias específicas) tal como están redactados, sin códigos. Máximo 12.

${guia}`,
  });
  return out.resultados.map((s) => s.trim()).filter(Boolean).slice(0, 12);
}

/**
 * Ranks subjects of the official catalog against the participant's evidences and, optionally, what they say
 * they want to accredit. Claude may only choose catalog subjects and their official learning outcomes.
 */
export async function proposeAccreditations({ intencion, evidencias, catalogo }) {
  const evIds = evidencias.map((e) => e.id);
  const asigIds = catalogo.map((a) => a.id);
  if (!asigIds.length) return { propuestas: [], sin_coincidencia: intencion ? "Todavía no hay asignaturas en el catálogo oficial de Lumen." : "" };
  const resumenEv = evidencias.slice(-40).map((e) => `- id ${e.id} · «${e.titulo}» · ${e.contexto || "contexto sin indicar"} · ${e.horas || 0} h · ${e.fecha}\n  ${Object.values(e.evidencias || {}).join(" ").slice(0, 600)}`).join("\n");
  const resumenCat = catalogo.slice(0, 150).map((a) => `- asignatura ${a.id} · «${a.asignatura}» · ${a.titulacion} · ${a.universidad} · ${a.ects} ECTS\n${a.resultados.map((r) => `    ${r.id}: ${r.texto}`).join("\n")}`).join("\n");
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["propuestas", "sin_coincidencia"],
    properties: {
      propuestas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["asignatura_id", "cobertura", "encaje", "motivo", "siguientes_pasos"],
          properties: {
            asignatura_id: { type: "string", enum: asigIds },
            cobertura: { type: "array", items: { type: "object", additionalProperties: false, required: ["resultado_id", "evidencias"], properties: { resultado_id: str, evidencias: { type: "array", items: { type: "string", enum: evIds.length ? evIds : ["-"] } } } } },
            encaje: { type: "integer", description: "0-100" },
            motivo: str,
            siguientes_pasos: { type: "array", items: str },
          },
        },
      },
      sin_coincidencia: str,
    },
  };
  const validator = z.object({
    propuestas: z.array(z.object({ asignatura_id: z.string(), cobertura: z.array(z.object({ resultado_id: z.string(), evidencias: z.array(z.string()) })), encaje: z.number(), motivo: z.string(), siguientes_pasos: z.array(z.string()) })),
    sin_coincidencia: z.string(),
  });
  const out = await jsonCall({
    schema,
    validator,
    prompt: `Eres el orientador de acreditación de Lumen. Relaciona los aprendizajes documentados por esta persona con asignaturas del CATÁLOGO OFICIAL de abajo. Son asignaturas reales con sus resultados de aprendizaje oficiales: no propongas nada que no esté en él ni cambies sus resultados.

${intencion ? `Lo que la persona quiere acreditar: «${intencion}»` : "La persona no ha dicho qué quiere acreditar: elige las asignaturas con mejor encaje."}

Catálogo oficial:
${resumenCat}

Evidencias documentadas:
${resumenEv || "(todavía ninguna)"}

Instrucciones:
- Devuelve de 0 a 3 asignaturas del catálogo, de mayor a menor encaje.${intencion ? " Prioriza las que respondan a lo que pide; si ninguna del catálogo encaja con su petición, no fuerces una: explícalo en sin_coincidencia." : " Devuelve solo las que tengan alguna relación real con sus evidencias."}
- cobertura: para cada resultado de aprendizaje de la asignatura (usa su id oficial: RA1, RA2…), los id de las evidencias que lo respaldan de verdad; lista vacía si ninguna.
- encaje (0-100): qué parte de los resultados de aprendizaje está ya respaldada con evidencias de calidad.
- motivo: dos frases que expliquen por qué encaja, citando evidencias concretas por su título.
- siguientes_pasos: de 2 a 4 acciones concretas para cubrir los resultados que faltan (qué documentar, qué producto adjuntar, a quién pedir confirmación).
- sin_coincidencia: ${intencion ? "si lo que pide no está en el catálogo, una frase que lo diga; si sí está, cadena vacía" : "cadena vacía"}.
- Responde en español.`,
  });
  const byId = new Map(catalogo.map((a) => [a.id, a]));
  const propuestas = out.propuestas.filter((p) => byId.has(p.asignatura_id)).slice(0, 3).map((p) => {
    const a = byId.get(p.asignatura_id), raIds = new Set(a.resultados.map((r) => r.id));
    return {
      asignatura_id: a.id, asignatura: a.asignatura, titulacion: a.titulacion, universidad: a.universidad, ects: Number(a.ects), nivel: a.nivel,
      resultados: a.resultados, fuente_url: a.fuente_url,
      cobertura: p.cobertura.filter((c) => raIds.has(c.resultado_id)).map((c) => ({ resultado_id: c.resultado_id, evidencias: c.evidencias.filter((id) => evIds.includes(id)) })),
      encaje: Math.max(0, Math.min(100, Math.round(p.encaje))), motivo: p.motivo, siguientes_pasos: p.siguientes_pasos.slice(0, 4),
    };
  });
  return { propuestas, sin_coincidencia: out.sin_coincidencia };
}

/** Reads an official teaching guide (guía docente) and extracts the subject's data and learning outcomes verbatim. */
export async function extractSubject({ fuente }) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["es_guia_docente", "universidad", "titulacion", "nivel", "asignatura", "codigo_asignatura", "curso_academico", "ects", "caracter", "resultados", "aviso"],
    properties: {
      es_guia_docente: { type: "boolean" },
      universidad: str, titulacion: str,
      nivel: { type: "string", enum: ["Grado", "Máster", "Microcredencial", "Título propio"] },
      asignatura: str, codigo_asignatura: str, curso_academico: str,
      ects: { type: "number" }, caracter: str,
      resultados: { type: "array", items: str },
      aviso: str,
    },
  };
  const validator = z.object({ es_guia_docente: z.boolean(), universidad: z.string(), titulacion: z.string(), nivel: z.string(), asignatura: z.string(), codigo_asignatura: z.string(), curso_academico: z.string(), ects: z.number(), caracter: z.string(), resultados: z.array(z.string()), aviso: z.string() });
  return jsonCall({
    schema,
    validator,
    fuente,
    effort: "medium",
    prompt: `El documento de arriba debería ser la guía docente oficial de una asignatura universitaria. Extrae sus datos COPIÁNDOLOS LITERALMENTE del documento, sin resumir, completar ni inventar nada.

- es_guia_docente: false si el documento no es la guía docente de una asignatura concreta.
- universidad, titulacion (nombre oficial completo del título), asignatura, codigo_asignatura, curso_academico (por ejemplo 2025-26), caracter (básica, obligatoria, optativa…): tal como aparecen; cadena vacía si no aparecen.
- nivel: Grado, Máster, Microcredencial o Título propio.
- ects: los créditos ECTS de la asignatura; 0 si no aparecen.
- resultados: los resultados de aprendizaje de la asignatura, cada uno tal como está redactado. Si la guía no tiene un apartado de resultados de aprendizaje, usa las competencias específicas de la asignatura. No incluyas competencias genéricas o transversales del título si hay resultados específicos.
- aviso: una frase si falta algo importante o hay dudas (por ejemplo, curso académico antiguo o resultados no encontrados); cadena vacía si todo está claro.`,
  });
}

/**
 * Searches the web for the organisations, projects, studies or works a participant mentions and writes a short
 * context sheet with its sources. Returns { nada: true } when the text names nothing worth searching for.
 */
export async function researchReference({ texto, conversacion, yaBuscado = "" }) {
  const messages = [{
    role: "user",
    content: `Una persona está documentando lo que ha aprendido para pedir un reconocimiento universitario. Ha mencionado esto:

«${texto}»
${conversacion ? `\nContexto de la conversación hasta ahora:\n${conversacion}\n` : ""}
Si menciona algo concreto que se pueda buscar (una empresa, un proyecto, una organización, un estudio, un curso, una publicación, un evento, un producto), búscalo en internet y escribe una ficha de contexto en español para el entrevistador:
- Qué es, a qué se dedica o de qué trata, cuándo y dónde, y datos verificables (cifras, fechas, hitos, premios, alcance).
- Qué papel aparece en las fuentes de personas concretas, si las fuentes lo dicen. No atribuyas a esta persona nada que no digan las fuentes.
- Máximo 250 palabras, sin listas largas. Si hay varias entidades con ese nombre, describe la más probable según el contexto y avisa de la ambigüedad.
- Empieza con una línea «RESUMEN: …» de una o dos frases.
Si no menciona nada concreto que buscar, responde exactamente «NADA».${yaBuscado ? `\n\nYa se buscó esto antes; busca solo lo que sea nuevo y, si no hay nada nuevo que buscar, responde «NADA»:\n${yaBuscado}` : ""}`,
  }];
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 4, user_location: { type: "approximate", country: "ES" } }];
  let content = [];
  for (let i = 0; i < 3; i++) {
    const response = await client.beta.messages.create({ model: MODEL, max_tokens: 8000, betas: BETAS, fallbacks: "default", output_config: { effort: "low" }, tools, messages });
    if (response.stop_reason === "refusal") throw new HttpError(422, "No he podido buscar información sobre eso.");
    content = content.concat(response.content);
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  const texto_ficha = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!texto_ficha || /^NADA\.?$/i.test(texto_ficha)) return { nada: true };

  const fuentes = new Map();
  for (const b of content) {
    if (b.type === "text") for (const c of b.citations || []) if (c.url) fuentes.set(c.url, c.title || c.url);
  }
  if (!fuentes.size) {
    for (const b of content) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content.slice(0, 3)) if (r.url) fuentes.set(r.url, r.title || r.url);
  }
  if (!fuentes.size) return { nada: true };
  const resumen = (texto_ficha.match(/RESUMEN:\s*(.+)/i)?.[1] || "").trim();
  return { nada: false, resumen, ficha: texto_ficha, fuentes: [...fuentes].slice(0, 6).map(([url, title]) => ({ url, title })) };
}

/** Reviews a proof the participant attached (file or link) against the official learning outcomes. */
export async function reviewArtefact({ doc, nombre, evidencia, objetivo }) {
  const ras = objetivo?.resultados || [];
  const ids = ras.map((r) => r.id);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["legible", "que_es", "resultados", "autoria", "relevancia", "notas"],
    properties: {
      legible: { type: "boolean" },
      que_es: str,
      resultados: { type: "array", items: { type: "string", enum: ids.length ? ids : ["-"] } },
      autoria: str,
      relevancia: score,
      notas: str,
    },
  };
  const validator = z.object({ legible: z.boolean(), que_es: z.string(), resultados: z.array(z.string()), autoria: z.string(), relevancia: z.number(), notas: z.string() });
  const prompt = `Arriba está «${nombre}», una prueba que una persona aporta para demostrar un aprendizaje en un expediente de reconocimiento universitario.

Evidencia a la que la aporta: «${evidencia.titulo}». ${String(evidencia.resumen || "").slice(0, 1500)}
${ras.length ? `Resultados de aprendizaje oficiales de su acreditación:\n${ras.map((r) => `${r.id}: ${r.texto}`).join("\n")}` : "Todavía no ha elegido acreditación."}

Revísala solo a partir de lo que contiene:
- legible: false si no se puede leer o está vacía.
- que_es: una frase sobre qué es el documento y qué muestra.
- resultados: los ID de los resultados de aprendizaje que este documento respalda de verdad (0 a 3).
- autoria: una frase sobre qué indicios hay de que la persona lo hizo o participó (firma, autoría, mención, correo dirigido a ella, metadatos visibles), o «sin indicios claros».
- relevancia (0-3): cuánto refuerza la evidencia.
- notas: una frase con lo que convendría añadir o comprobar; cadena vacía si nada.`;
  const out = await jsonCall({ schema, validator, prompt, fuente: doc, effort: "low" });
  return { ...out, resultados: out.resultados.filter((id) => ids.includes(id)).slice(0, 3), relevancia: Math.max(0, Math.min(3, Math.round(out.relevancia))) };
}

/**
 * Fallback reader for pages our own fetch can't extract (scripts, unusual markup): Claude fetches the page
 * itself and copies its main content. Returns "" when the page can't be read.
 */
export async function readPageWithClaude(url) {
  const messages = [{ role: "user", content: `Lee esta página con la herramienta web_fetch: ${url}\n\nDespués copia literalmente su contenido principal (todo el texto relevante, en su idioma original), sin menús, pies de página ni publicidad, y sin comentarios tuyos. Si no puedes leerla o está vacía, responde exactamente «NADA».` }];
  const tools = [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 2 }];
  let content = [];
  for (let i = 0; i < 3; i++) {
    const response = await client.beta.messages.create({ model: MODEL, max_tokens: 16000, betas: BETAS, fallbacks: "default", output_config: { effort: "low" }, tools, messages });
    if (response.stop_reason === "refusal") return "";
    content = content.concat(response.content);
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return !text || /^NADA\.?$/i.test(text) ? "" : text;
}
