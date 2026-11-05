// Claude calls: the interview turn (streamed) and structured analyses (JSON).
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { HttpError } from "./server.js";

export const MODEL = process.env.LUMEN_MODEL || "claude-opus-5-5";
const BETAS = ["server-side-fallback-2026-07-01"];
const client = new Anthropic();

export const CONTEXTOS = ["Trabajo", "Voluntariado", "Formación no reglada", "Vida diaria / autodidacta"];

function objetivoText(obj) {
  const nombre = obj?.generico
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
Si una respuesta es vaga, pide el detalle que falta (un ejemplo, una cifra, un paso concreto) antes de seguir. Si contradice el contenido o es inexacta, pregúntale cómo encaja con lo que dice el material, sin corregirle tú. Si dice que no sabe, baja un escalón y ayúdale a anclarse en lo que sí sabe.

DATOS QUE DEBE TENER EL EXPEDIENTE
Cuando encajen de forma natural, sin convertirlo en un formulario, consigue también: el contexto, una fecha aproximada y las horas dedicadas; un producto verificable que pueda adjuntar (documento, informe, código, material); y quién podría confirmarlo (nombre y rol).
Orienta todo hacia los resultados de aprendizaje con los que encaja lo que cuenta. Si nada encaja, díselo con tacto y busca la conexión más honesta.

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
export async function streamInterviewTurn({ objetivo, titulo, history, closing, fuente, onText }) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const intro = `Lo que quiero documentar: «${titulo}».${fuente ? " Te adjunto el contenido del que aprendí: basa tus preguntas en él." : ""}\n\n${messages[0].content}`;
  messages[0] = { role: "user", content: fuente ? [fuente, { type: "text", text: intro }] : intro };
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

async function jsonCall({ prompt, schema, validator, effort = "medium", fuente = null }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: fuente ? [fuente, { type: "text", text: prompt }] : prompt }],
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

export async function analyzeInterview({ objetivo, titulo, history, today, fuente = null }) {
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
    prompt: `Analiza esta entrevista para un expediente de reconocimiento académico de aprendizajes por experiencia. Usa solo lo que dijo la persona y no inventes nada.${fuente ? " La persona adjuntó el documento de arriba como contenido del que aprendió: úsalo solo para comprobar si sus explicaciones son fieles a él, nunca como evidencia de lo que ella sabe." : ""}

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

const TIPOS = ["Asignatura de grado", "Asignatura de máster", "Microcredencial", "Competencia transversal"];

/**
 * Proposes accreditation targets from the participant's evidences and, optionally, what they say they want.
 * `evidencias` are the stored evidence objects; only their own ids may appear in the coverage map.
 */
export async function proposeAccreditations({ intencion, objetivo, evidencias }) {
  const evIds = evidencias.map((e) => e.id);
  const resumen = evidencias
    .slice(-40)
    .map((e) => {
      const txt = Object.values(e.evidencias || {}).join(" ").slice(0, 600);
      return `- id ${e.id} · «${e.titulo}» · ${e.contexto || "contexto sin indicar"} · ${e.horas || 0} h · ${e.fecha}\n  ${txt}`;
    })
    .join("\n");
  const actual = objetivo?.resultados?.length && !objetivo.generico ? [objetivo.asignatura, objetivo.titulacion].filter(Boolean).join(" · ") : "ninguno";
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["propuestas"],
    properties: {
      propuestas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["titulo", "tipo", "titulacion", "asignatura", "ects", "resultados", "cobertura", "encaje", "motivo", "siguientes_pasos"],
          properties: {
            titulo: str,
            tipo: { type: "string", enum: TIPOS },
            titulacion: str,
            asignatura: str,
            ects: { type: "number" },
            resultados: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "texto"], properties: { id: str, texto: str } } },
            cobertura: { type: "array", items: { type: "object", additionalProperties: false, required: ["resultado_id", "evidencias"], properties: { resultado_id: str, evidencias: { type: "array", items: { type: "string", enum: evIds.length ? evIds : ["-"] } } } } },
            encaje: { type: "integer", description: "0-100" },
            motivo: str,
            siguientes_pasos: { type: "array", items: str },
          },
        },
      },
    },
  };
  const validator = z.object({
    propuestas: z.array(
      z.object({
        titulo: z.string(), tipo: z.string(), titulacion: z.string(), asignatura: z.string(), ects: z.number(),
        resultados: z.array(z.object({ id: z.string(), texto: z.string() })),
        cobertura: z.array(z.object({ resultado_id: z.string(), evidencias: z.array(z.string()) })),
        encaje: z.number(), motivo: z.string(), siguientes_pasos: z.array(z.string()),
      }),
    ),
  });
  const out = await jsonCall({
    schema,
    validator,
    prompt: `Eres el orientador de acreditación de Lumen. Propón objetivos de reconocimiento académico (en el sistema universitario español) que encajen con los aprendizajes que esta persona ya ha documentado${intencion ? " y con lo que dice que quiere acreditar" : ""}.

${intencion ? `Lo que la persona quiere acreditar: «${intencion}»\n` : "La persona no ha dicho qué quiere acreditar: propón tú las opciones con mejor encaje.\n"}Objetivo activo ahora: ${actual}.

Evidencias documentadas:
${resumen || "(todavía ninguna)"}

Instrucciones:
- Devuelve de 1 a 3 propuestas, de mayor a menor encaje.${intencion ? " La primera debe responder a lo que la persona pide, aunque su encaje sea bajo; dile con franqueza cuánto le falta." : ""}
- Para cada una: el tipo; una titulación y una asignatura plausibles y habituales en universidades españolas (genéricas, sin inventar códigos ni afirmar que existen tal cual en una universidad concreta); los ECTS habituales; de 4 a 6 resultados de aprendizaje redactados como en una guía docente, con id RA1, RA2…
- cobertura: para cada resultado, los id de las evidencias que lo respaldan de verdad (lista vacía si ninguna).
- encaje (0-100): qué parte de los resultados está ya respaldada con evidencias de calidad.
- motivo: dos frases que expliquen por qué encaja, citando evidencias concretas por su título.
- siguientes_pasos: de 2 a 4 acciones concretas para completar las evidencias que faltan (qué documentar, qué producto adjuntar, a quién pedir confirmación).
- Responde en español.`,
  });
  return out.propuestas.slice(0, 3).map((p) => {
    const ras = p.resultados.slice(0, 8).map((r, i) => ({ id: `RA${i + 1}`, texto: r.texto.trim(), _orig: r.id }));
    const idMap = new Map(ras.map((r) => [r._orig, r.id]));
    return {
      titulo: p.titulo, tipo: TIPOS.includes(p.tipo) ? p.tipo : TIPOS[0], titulacion: p.titulacion, asignatura: p.asignatura,
      ects: Math.max(0, Math.min(60, p.ects)), resultados: ras.map(({ id, texto }) => ({ id, texto })),
      cobertura: p.cobertura.filter((c) => idMap.has(c.resultado_id)).map((c) => ({ resultado_id: idMap.get(c.resultado_id), evidencias: c.evidencias.filter((id) => evIds.includes(id)) })),
      encaje: Math.max(0, Math.min(100, Math.round(p.encaje))), motivo: p.motivo, siguientes_pasos: p.siguientes_pasos.slice(0, 4),
    };
  });
}
