-- Lumen · migración 004: trayectoria pública encontrada en internet.
-- Ejecútala en el SQL Editor de Supabase (también va incluida en schema.sql para instalaciones nuevas).
alter table public.perfiles add column if not exists trayectoria jsonb not null default '{}'::jsonb;
grant update (trayectoria) on public.perfiles to authenticated;
-- El servidor registra el uso de la IA con la clave de servicio.
grant execute on function public.registrar_uso_ia(uuid, integer) to service_role;
