-- Lumen · migración 007: árbol de acreditaciones.
-- Cada persona puede perseguir varias acreditaciones (asignaturas reales del catálogo), cada una con su
-- propia conversación, sus recursos y su recorrido. Las evidencias indican a qué acreditaciones sirven.
create table if not exists public.acreditaciones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  asignatura_id uuid not null references public.catalogo_asignaturas (id),
  estado text not null default 'activa' check (estado in ('activa', 'presentada', 'archivada')),
  conversacion jsonb not null default '{}'::jsonb,
  recursos jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, asignatura_id)
);
create index if not exists acreditaciones_user_idx on public.acreditaciones (user_id);

drop trigger if exists acreditaciones_updated on public.acreditaciones;
create trigger acreditaciones_updated before update on public.acreditaciones for each row execute function public.tocar_updated_at();

alter table public.acreditaciones enable row level security;
drop policy if exists "acreditaciones: leer" on public.acreditaciones;
create policy "acreditaciones: leer" on public.acreditaciones for select to authenticated
  using (user_id = auth.uid() or (public.es_coordinador() and public.comparte_con_coordinacion(user_id)));
drop policy if exists "acreditaciones: crear" on public.acreditaciones;
create policy "acreditaciones: crear" on public.acreditaciones for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "acreditaciones: editar" on public.acreditaciones;
create policy "acreditaciones: editar" on public.acreditaciones for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "acreditaciones: borrar" on public.acreditaciones;
create policy "acreditaciones: borrar" on public.acreditaciones for delete to authenticated using (user_id = auth.uid());
