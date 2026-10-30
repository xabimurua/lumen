-- Lumen · esquema de base de datos para Supabase (PostgreSQL).
-- Ejecútalo una vez en el editor SQL del proyecto (SQL Editor → New query → Run).

-- ---------------------------------------------------------------------------
-- Perfiles: uno por participante. El rol solo se cambia desde el panel o SQL.
-- ---------------------------------------------------------------------------
create table if not exists public.perfiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null default '',
  role text not null default 'participante' check (role in ('participante', 'coordinador')),
  consentimiento_at timestamptz,
  consentimiento_version text,
  compartir_con_coordinacion boolean not null default false,
  objetivo jsonb not null default '{}'::jsonb,
  propuestas jsonb not null default '[]'::jsonb,
  propuestas_n_evidencias integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Evidencias: el contenido vive en `data` (jsonb) para poder evolucionar el formato.
-- ---------------------------------------------------------------------------
create table if not exists public.evidencias (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists evidencias_user_idx on public.evidencias (user_id);

-- ---------------------------------------------------------------------------
-- Uso diario de la IA (solo lo escribe el servidor con la service role key).
-- ---------------------------------------------------------------------------
create table if not exists public.uso_ia (
  user_id uuid not null references auth.users (id) on delete cascade,
  dia date not null default current_date,
  llamadas integer not null default 0,
  primary key (user_id, dia)
);

create or replace function public.registrar_uso_ia(p_user uuid, p_limite integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into uso_ia (user_id, dia, llamadas) values (p_user, current_date, 1)
  on conflict (user_id, dia) do update set llamadas = uso_ia.llamadas + 1
  returning llamadas into n;
  return n <= p_limite;
end $$;
revoke execute on function public.registrar_uso_ia(uuid, integer) from public, anon, authenticated;

create or replace function public.es_coordinador()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfiles where user_id = auth.uid() and role = 'coordinador');
$$;

create or replace function public.comparte_con_coordinacion(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select compartir_con_coordinacion from perfiles where user_id = p_user), false);
$$;

create or replace function public.tocar_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists perfiles_updated on public.perfiles;
create trigger perfiles_updated before update on public.perfiles for each row execute function public.tocar_updated_at();
drop trigger if exists evidencias_updated on public.evidencias;
create trigger evidencias_updated before update on public.evidencias for each row execute function public.tocar_updated_at();

-- ---------------------------------------------------------------------------
-- Seguridad a nivel de fila
-- ---------------------------------------------------------------------------
alter table public.perfiles enable row level security;
alter table public.evidencias enable row level security;
alter table public.uso_ia enable row level security;

-- Nadie puede elegir su propio rol: se retiran los permisos sobre esa columna.
revoke insert, update on public.perfiles from anon, authenticated;
grant insert (user_id, nombre, consentimiento_at, consentimiento_version, compartir_con_coordinacion, objetivo) on public.perfiles to authenticated;
grant update (nombre, consentimiento_at, consentimiento_version, compartir_con_coordinacion, objetivo, propuestas) on public.perfiles to authenticated;

drop policy if exists "perfil propio: leer" on public.perfiles;
create policy "perfil propio: leer" on public.perfiles for select to authenticated
  using (user_id = auth.uid() or (public.es_coordinador() and compartir_con_coordinacion));
drop policy if exists "perfil propio: crear" on public.perfiles;
create policy "perfil propio: crear" on public.perfiles for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "perfil propio: editar" on public.perfiles;
create policy "perfil propio: editar" on public.perfiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "evidencias: leer" on public.evidencias;
create policy "evidencias: leer" on public.evidencias for select to authenticated
  using (user_id = auth.uid() or (public.es_coordinador() and public.comparte_con_coordinacion(user_id)));
drop policy if exists "evidencias: crear" on public.evidencias;
create policy "evidencias: crear" on public.evidencias for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "evidencias: editar" on public.evidencias;
create policy "evidencias: editar" on public.evidencias for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "evidencias: borrar" on public.evidencias;
create policy "evidencias: borrar" on public.evidencias for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Archivos (productos, cartas de confirmación): bucket privado, una carpeta por persona.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('artefactos', 'artefactos', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "artefactos: subir propios" on storage.objects;
create policy "artefactos: subir propios" on storage.objects for insert to authenticated
  with check (bucket_id = 'artefactos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "artefactos: leer" on storage.objects;
create policy "artefactos: leer" on storage.objects for select to authenticated
  using (bucket_id = 'artefactos' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (public.es_coordinador() and public.comparte_con_coordinacion(((storage.foldername(name))[1])::uuid))
  ));
drop policy if exists "artefactos: borrar propios" on storage.objects;
create policy "artefactos: borrar propios" on storage.objects for delete to authenticated
  using (bucket_id = 'artefactos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Para nombrar a alguien coordinador del piloto (tras su primer inicio de sesión):
--   update public.perfiles set role = 'coordinador'
--   where user_id = (select id from auth.users where email = 'correo@universidad.es');
-- ---------------------------------------------------------------------------
