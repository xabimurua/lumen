-- Lumen · migración 002: propuestas de acreditación.
-- Solo si ya ejecutaste schema.sql antes de esta versión. En instalaciones nuevas no hace falta.
alter table public.perfiles add column if not exists propuestas jsonb not null default '[]'::jsonb;
alter table public.perfiles add column if not exists propuestas_n_evidencias integer not null default 0;
grant update (propuestas) on public.perfiles to authenticated;
