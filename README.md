# Lumen

Plataforma para convertir lo que una persona aprende en su día a día (trabajo, voluntariado, formación no reglada, vida diaria) en evidencias que una universidad pueda valorar para reconocer créditos.

- **Diario rápido**: registros breves con contexto, horas, fecha y una prueba adjunta.
- **Entrevista de evidencias**: Claude pregunta hasta reunir lo que pide un expediente y vincula cada evidencia con los resultados de aprendizaje de la asignatura.
- **Criterios de valoración**: validez, autenticidad, suficiencia y vigencia, con cinco comprobaciones por resultado de aprendizaje.
- **Catálogo oficial**: solo se acredita contra asignaturas reales, dadas de alta por la coordinación a partir de su guía docente oficial, con sus resultados de aprendizaje literales.
- **Propuestas de acreditación**: la persona dice qué quiere acreditar, o Lumen analiza sus evidencias cada pocas entradas y le propone asignaturas del catálogo, con el porcentaje cubierto y los siguientes pasos.
- **Progreso como en un curso**: avance por resultado de aprendizaje y horas documentadas frente a la carga de trabajo de los ECTS de la asignatura.
- **Mi trayectoria**: la persona sube su currículum o su perfil de LinkedIn en PDF y, si lo autoriza, Lumen investiga además su trayectoria pública en internet, cruza ambas fuentes y busca respaldo público para cada experiencia, mostrando el progreso en vivo. Lo que es claramente suyo se carga como evidencias; lo dudoso queda por revisar. Todo se ve en una línea de vida.
- **Completar con 3 preguntas**: cualquier evidencia con poca profundidad se completa respondiendo por escrito tres preguntas hechas a medida.
- **Guía de siguiente paso** y recuperación de entrevistas a medias al recargar.
- **Recursos recomendados**: libros, vídeos de YouTube, artículos, pódcast de Spotify y cursos reales para los resultados de aprendizaje que faltan; al terminar uno, Lumen entrevista a la persona sobre lo aprendido.
- **Pruebas desde cualquier sitio**: archivos, enlaces externos y Google Drive (solo los archivos elegidos). Lumen revisa cada prueba: qué es, qué resultados respalda e indicios de autoría.
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
