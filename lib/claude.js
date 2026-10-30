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
  return `Eres Lumen, un agente que ayuda a una persona a convertir lo que aprende en su día a día (trabajo, voluntariado, formación no reglada, vida diaria) en evidencias que una universidad pueda valorar para reconocerle créditos.

Objetivo de acreditación: ${nombre}.
Resultados de aprendizaje del objetivo:
${ras}

Las evidencias deben ser válidas (ligadas a un resultado de aprendizaje), auténticas (comprobables), suficientes (con profundidad) y vigentes (recientes). A lo largo de la entrevista consigue, sin convertirla en un interrogatorio:
1) qué aprendió y cómo lo explica con sus palabras;
2) un caso concreto en el que lo aplicó y qué resultado obtuvo;
3) el contexto, una fecha aproximada y cuántas horas le dedicó;
4) qué producto verificable generó (documento, informe, código, material, registro) que pueda adjuntar;
5) quién podría confirmarlo (nombre y rol: responsable, cliente, coordinador…);
6) qué límites tiene su dominio y qué le falta por aprender.
Orienta las preguntas hacia los resultados de aprendizaje con los que encaja lo que cuenta. Si nada encaja, díselo con tacto y busca la conexión más honesta.

Estilo: español; tono cálido y exigente; en cada turno, como mucho una frase que recoja algo concreto de lo que dijo y después UNA sola pregunta abierta; sin listas ni markdown; máximo 70 palabras. No expliques el contenido por la persona. No prometas créditos ni digas que certificas nada.`;
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

/** Streams the next interviewer turn as plain text chunks to `onText`. */
export async function streamInterviewTurn({ objetivo, titulo, history, closing, onText }) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  messages[0] = { role: "user", content: `Lo que quiero documentar: «${titulo}».\n\n${messages[0].content}` };
  if (closing) messages.push({ role: "system", content: CLOSING });

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort: "low" },
    system: [{ type: "text", text: interviewSystem(objetivo), cache_control: { type: "ephemeral" } }],
    messages,
  });
  stream.on("text", (delta) => onText(delta));
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") throw new HttpError(422, "No he podido continuar con esa respuesta. Reformúlala, por favor.");
  return final.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

async function jsonCall({ prompt, schema, validator, effort = "medium" }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: BETAS,
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
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

export async function analyzeInterview({ objetivo, titulo, history, today }) {
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
        required: ["idea", "aplicacion", "argumentacion", "conexion", "limites"],
        properties: { idea: str, aplicacion: str, argumentacion: str, conexion: str, limites: str },
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
    evidencias: z.object({ idea: z.string(), aplicacion: z.string(), argumentacion: z.string(), conexion: z.string(), limites: z.string() }),
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
    prompt: `Analiza esta entrevista para un expediente de reconocimiento académico de aprendizajes por experiencia. Usa solo lo que dijo la persona y no inventes nada.

Resultados de aprendizaje disponibles:
${ras}

- titulo: nombre breve y descriptivo de la evidencia (máximo 8 palabras).
- evidencias: una o dos frases en tercera persona por apartado, parafraseando a la persona; cadena vacía si no hay evidencia para ese apartado.
- resultados: solo los ID a los que esta evidencia aporte de verdad (de 0 a 3).
- validez (0-3): grado en que lo contado demuestra esos resultados. suficiencia (0-3): profundidad (explica, aplica con un caso, da resultados, reconoce límites).
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
