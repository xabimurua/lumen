# Lumen

Plataforma para convertir lo que una persona aprende en su día a día (trabajo, voluntariado, formación no reglada, vida diaria) en evidencias que una universidad pueda valorar para reconocer créditos.

- **Diario rápido**: registros breves con contexto, horas, fecha y una prueba adjunta.
- **Entrevista de evidencias**: Claude pregunta hasta reunir lo que pide un expediente y vincula cada evidencia con los resultados de aprendizaje de la asignatura.
- **Criterios de valoración**: validez, autenticidad, suficiencia y vigencia, con cinco comprobaciones por resultado de aprendizaje.
- **Propuestas de acreditación**: la persona dice qué quiere acreditar, o Lumen analiza sus evidencias cada pocas entradas y le propone dónde pueden contar, con el porcentaje cubierto y los siguientes pasos. Una propuesta se adopta como objetivo con un clic.
- **Expediente** descargable para presentar a la universidad.
- **Coordinación del piloto**: vista de solo lectura de los expedientes que cada participante decide compartir.
- **Datos bajo control de cada participante**: consentimiento informado, descarga de datos y borrado de la cuenta.

## Arquitectura

| Pieza | Qué hace | Dónde vive |
|---|---|---|
| `public/` | Web (HTML, CSS y JS sin compilación; fuentes y librería de Supabase incluidas en el repositorio) | Vercel |
| `api/` | Funciones del servidor: entrevista con Claude, análisis, borrado de cuenta | Vercel Functions (Fráncfort) |
| `supabase/schema.sql` | Tablas, seguridad por fila y almacenamiento de archivos | Supabase (región UE) |

La clave de la API de Anthropic y la clave de servicio de Supabase solo existen en el servidor. Cada llamada a la IA comprueba la sesión, el consentimiento y un límite diario por persona.

## Despliegue

Sigue [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

## Desarrollo local

```bash
npm install
```

```bash
npx vercel dev
```

Necesitas un archivo `.env` con las variables de `.env.example`. Para comprobar la sintaxis:

```bash
npm run check
```
