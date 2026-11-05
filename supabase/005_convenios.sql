-- Lumen · migración 005: asignaturas detectadas por Lumen en universidades sin convenio.
-- «publicada» = universidad con convenio con Lumen; «detectada» = asignatura real encontrada por Lumen, sin convenio todavía.
alter table public.catalogo_asignaturas drop constraint if exists catalogo_asignaturas_estado_check;
alter table public.catalogo_asignaturas add constraint catalogo_asignaturas_estado_check
  check (estado in ('borrador', 'publicada', 'detectada', 'retirada'));
alter table public.catalogo_asignaturas add column if not exists detectada_por uuid references auth.users (id) on delete set null;
create unique index if not exists catalogo_fuente_unica on public.catalogo_asignaturas (fuente_url) where estado <> 'retirada';

drop policy if exists "catalogo: leer" on public.catalogo_asignaturas;
create policy "catalogo: leer" on public.catalogo_asignaturas for select to authenticated
  using (estado in ('publicada', 'detectada') or public.es_coordinador());
