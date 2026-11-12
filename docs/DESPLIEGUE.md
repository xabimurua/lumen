# Puesta en producción del piloto

Guía para desplegar Lumen para un piloto de hasta 30 participantes durante 3 meses. Tiempo estimado: una hora.

Necesitas cuatro cuentas: **GitHub**, **Supabase**, **Vercel** y **Anthropic Console**. Y, para enviar los correos de acceso, un proveedor de correo (por ejemplo Resend o Brevo) o el servidor SMTP de tu institución.

---

## 1. Subir el código a GitHub

1. Crea un repositorio privado vacío, por ejemplo `lumen`.
2. Sube este proyecto a ese repositorio.

## 2. Supabase: base de datos, acceso y archivos

1. En [supabase.com](https://supabase.com), crea un proyecto nuevo. En **Region**, elige una región de la UE (por ejemplo *Central EU (Frankfurt)*). Guarda la contraseña de la base de datos en un lugar seguro.
2. Abre **SQL Editor → New query**, pega el contenido de `supabase/schema.sql` y pulsa **Run**. Crea las tablas, las reglas de seguridad y el almacén privado `artefactos`. (Si ya lo habías ejecutado con una versión anterior, ejecuta también `supabase/002_propuestas.sql`, `supabase/003_catalogo.sql`, `supabase/004_trayectoria.sql`, `supabase/005_convenios.sql`, `supabase/006_recursos.sql`, `supabase/007_acreditaciones.sql` y `supabase/008_perfil.sql`, en ese orden.)
3. En **Authentication → URL Configuration**:
   - **Site URL**: la dirección final de Lumen (por ejemplo `https://lumen.tudominio.es`, o la de Vercel del paso 3).
   - **Redirect URLs**: añade esa misma dirección.
4. En **Authentication → Sign In / Providers → Email**: deja activado *Email* y **desactiva «Allow new users to sign up»**. Así solo entran las personas que invites.
5. En **Authentication → Emails → SMTP Settings**, configura un SMTP propio. El correo que trae Supabase de serie solo envía unos pocos mensajes por hora y no sirve para un piloto real.
6. Opcional: en **Authentication → Emails → Templates → Magic Link**, traduce el asunto y el texto al español.
7. En **Project Settings → API**, copia:
   - *Project URL* → `SUPABASE_URL`
   - clave *anon / publishable* → `SUPABASE_ANON_KEY`
   - clave *service_role / secret* → `SUPABASE_SERVICE_ROLE_KEY` (nunca la compartas ni la pongas en el navegador)

## 3. Anthropic: clave de la API

1. En [platform.claude.com](https://platform.claude.com), crea una clave en **API Keys** → `ANTHROPIC_API_KEY`.
2. En **Billing**, añade saldo y fija un **límite de gasto mensual** (por ejemplo 100 USD) para que el coste nunca se dispare.

## 4. Vercel: la web

1. En [vercel.com](https://vercel.com), pulsa **Add New → Project** e importa el repositorio de GitHub. No hace falta tocar la configuración de compilación.
2. Antes de desplegar, en **Environment Variables**, añade las cuatro variables de `.env.example` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`). `LUMEN_DAILY_AI_LIMIT` es opcional.
3. Pulsa **Deploy**. Al terminar tendrás una dirección del tipo `https://lumen-xxxx.vercel.app`.
4. Opcional: en **Settings → Domains**, añade un dominio propio.
5. Vuelve a Supabase (paso 2.3) y comprueba que *Site URL* y *Redirect URLs* coinciden con la dirección final.

## 5. Dar de alta a las personas del piloto

1. En Supabase, **Authentication → Users → Add user → Send invitation**, invita a cada participante por correo.
2. Cada persona recibe un enlace, entra, da su consentimiento y empieza.
3. Para nombrar coordinadora a una persona (por ejemplo, quien evalúa en la universidad), invítala igual y, después de su primer acceso, ejecuta en el SQL Editor:

```sql
update public.perfiles set role = 'coordinador'
where user_id = (select id from auth.users where email = 'correo@universidad.es');
```

## 5 bis. Cargar el catálogo oficial de asignaturas

Lumen solo deja acreditar asignaturas reales del catálogo. Antes de abrir el piloto, la persona coordinadora:

1. Entra en **Coordinación → Catálogo oficial de asignaturas**.
2. Pega la URL oficial de la guía docente (PDF o página de la universidad) y pulsa **Leer guía docente**. Si la página no se deja leer, despliega «pegar el texto de la guía».
3. Revisa cada campo con la guía: universidad, titulación oficial, código RUCT del título, asignatura, ECTS y, sobre todo, que los resultados de aprendizaje estén copiados literalmente.
4. Pulsa **Publicar en el catálogo**. Desde ese momento los participantes la ven y Lumen puede proponerla.

Las peticiones de asignaturas nuevas de los participantes aparecen en esa misma sección, en «Solicitudes de participantes».

## 5 ter. Opcional: conectar Google Drive

Permite a los participantes elegir archivos de su Drive como material o como prueba. Lumen pide el permiso `drive.file`: solo accede a los archivos que cada persona selecciona, nunca al resto de su Drive.

1. En https://console.cloud.google.com crea un proyecto (por ejemplo `Lumen`). En la página de inicio del proyecto, apunta el **Número del proyecto**: es `GOOGLE_APP_ID`.
2. En **APIs y servicios → Biblioteca**, activa **Google Drive API** y **Google Picker API**.
3. En **APIs y servicios → Pantalla de consentimiento de OAuth** (o «Google Auth Platform»): tipo **Externo**, nombre `Lumen`, tu correo de contacto. En permisos (*scopes*) añade `.../auth/drive.file`. Publica la aplicación («En producción»): con este permiso no suele hacer falta la verificación de Google.
4. En **APIs y servicios → Credenciales**:
   - **Crear credenciales → ID de cliente de OAuth**, tipo «Aplicación web». En **Orígenes de JavaScript autorizados** añade la dirección de Lumen (por ejemplo `https://lumen-lac-eight.vercel.app`). Copia el ID de cliente: es `GOOGLE_CLIENT_ID`.
   - **Crear credenciales → Clave de API**. Restríngela a **Google Picker API** y, en restricciones de aplicación, a sitios web con la dirección de Lumen seguida de `/*`. Es `GOOGLE_API_KEY`.
5. Añade las tres variables en Vercel y vuelve a desplegar. Aparecerán los botones 🗂 de Google Drive.

Las carpetas no se comparten enteras: la persona entra en la carpeta y elige los archivos que quiere aportar. Los documentos, hojas y presentaciones de Google se convierten a PDF.

**Gmail no se conecta** a propósito: el permiso para leer el correo es restringido, exige una auditoría de seguridad de Google y daría acceso a todo el buzón. Para aportar un correo (por ejemplo, la confirmación de un responsable), se descarga como `.eml` («Descargar mensaje» en Gmail) o se guarda como PDF y se adjunta: Lumen lo lee igual.

## 6. Antes de abrir el piloto: lista de comprobación

- [ ] `public/privacidad.html` sin ningún **[PENDIENTE]**, revisada por el delegado o la delegada de protección de datos.
- [ ] Contratos de encargo del tratamiento (DPA) aceptados con Supabase, Vercel y Anthropic.
- [ ] Límite de gasto mensual fijado en Anthropic Console.
- [ ] Altas abiertas desactivadas en Supabase y SMTP propio configurado.
- [ ] Prueba completa con una cuenta de prueba: acceso por correo, consentimiento, una entrevista, una entrada de diario con archivo, descarga del expediente y borrado de la cuenta.
- [ ] Prueba de la vista de coordinación con una cuenta coordinadora y un participante que comparte su expediente.
- [ ] Catálogo con al menos una asignatura publicada y revisada contra su guía docente oficial.
- [ ] Copias de seguridad: el plan gratuito de Supabase no las incluye y pausa los proyectos inactivos. Para un piloto real se recomienda el plan Pro.

## Costes orientativos (30 personas, 3 meses)

| Concepto | Estimación |
|---|---|
| IA (Claude Opus 5.5) | 100–250 USD en total, con unas 2 entrevistas por persona y semana más el diario. El límite diario por persona (`LUMEN_DAILY_AI_LIMIT`) y el límite de gasto de Anthropic acotan el máximo. |
| Supabase | 0 USD (plan gratuito) o 25 USD/mes (Pro: copias de seguridad y sin pausas) |
| Vercel | 0 USD (Hobby, uso no comercial) o 20 USD/mes (Pro) |
| Correo (SMTP) | 0 USD en los planes gratuitos de Resend o Brevo para este volumen |

Para abaratar la IA, se puede definir `LUMEN_MODEL=claude-sonnet-5-5` en Vercel. Cuesta la mitad y suele bastar para entrevistas, aunque conviene comprobar antes que la calidad de las preguntas no baja.

## Operación durante el piloto

- **Uso de la IA**: tabla `uso_ia` en Supabase (llamadas por persona y día).
- **Errores del servidor**: Vercel → proyecto → **Logs**.
- **Gasto**: Anthropic Console → **Usage**.
- **Exportar datos para la evaluación del piloto**: Supabase → **Table Editor → evidencias → Export to CSV**. Usa solo datos de quienes hayan dado su consentimiento y anonimízalos antes de analizarlos.
