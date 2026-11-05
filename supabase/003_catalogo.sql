-- Lumen · migración 003: catálogo oficial de asignaturas acreditables.
-- Ejecútalo en el SQL Editor de Supabase (también va incluido en schema.sql para instalaciones nuevas).

-- Asignaturas reales, dadas de alta por la coordinación a partir de su guía docente oficial.
create table if not exists public.catalogo_asignaturas (
  id uuid primary key default gen_random_uuid(),
  universidad text not null,
  titulacion text not null,
  codigo_ruct text not null default '',
  nivel text not null default 'Grado' check (nivel in ('Grado', 'Máster', 'Microcredencial', 'Título propio')),
  asignatura text not null,
  codigo_asignatura text not null default '',
  curso_academico text not null default '',
  ects numeric not null check (ects > 0 and ects <= 60),
  caracter text not null default '',
  resultados jsonb not null check (jsonb_typeof(resultados) = 'array' and jsonb_array_length(resultados) > 0),
  fuente_url text not null check (fuente_url ~ '^https?://'),
  estado text not null default 'borrador' check (estado in ('borrador', 'publicada', 'retirada')),
  revisado_por uuid references auth.users (id) on delete set null,
  revisado_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists catalogo_estado_idx on public.catalogo_asignaturas (estado);

-- Peticiones de participantes para añadir una asignatura que aún no está en el catálogo.
create table if not exists public.solicitudes_catalogo (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  texto text not null check (length(texto) between 3 and 1000),
  url text not null default '',
  estado text not null default 'pendiente' check (estado in ('pendiente', 'añadida', 'descartada')),
  created_at timestamptz not null default now()
);

drop trigger if exists catalogo_updated on public.catalogo_asignaturas;
create trigger catalogo_updated before update on public.catalogo_asignaturas for each row execute function public.tocar_updated_at();

alter table public.catalogo_asignaturas enable row level security;
alter table public.solicitudes_catalogo enable row level security;

drop policy if exists "catalogo: leer" on public.catalogo_asignaturas;
create policy "catalogo: leer" on public.catalogo_asignaturas for select to authenticated
  using (estado = 'publicada' or public.es_coordinador());
drop policy if exists "catalogo: gestionar" on public.catalogo_asignaturas;
create policy "catalogo: gestionar" on public.catalogo_asignaturas for all to authenticated
  using (public.es_coordinador()) with check (public.es_coordinador());

drop policy if exists "solicitudes: crear" on public.solicitudes_catalogo;
create policy "solicitudes: crear" on public.solicitudes_catalogo for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "solicitudes: leer" on public.solicitudes_catalogo;
create policy "solicitudes: leer" on public.solicitudes_catalogo for select to authenticated
  using (user_id = auth.uid() or public.es_coordinador());
drop policy if exists "solicitudes: gestionar" on public.solicitudes_catalogo;
create policy "solicitudes: gestionar" on public.solicitudes_catalogo for update to authenticated
  using (public.es_coordinador()) with check (public.es_coordinador());
