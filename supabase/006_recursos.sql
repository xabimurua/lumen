-- Lumen · migración 006: recursos de aprendizaje recomendados (libros, vídeos, artículos, pódcast).
alter table public.perfiles add column if not exists recursos jsonb not null default '{}'::jsonb;
grant update (recursos) on public.perfiles to authenticated;
