-- Lumen · migración 008: perfil con foto y ficha.
-- Ejecútala una vez en Supabase (SQL Editor → New query → Run).

-- Foto de perfil, guardada como imagen pequeña (data URL de unos 20-60 KB, recortada a 256 px).
alter table public.perfiles add column if not exists avatar text not null default '';
alter table public.perfiles drop constraint if exists perfiles_avatar_tamano;
alter table public.perfiles add constraint perfiles_avatar_tamano check (length(avatar) <= 400000 and (avatar = '' or avatar like 'data:image/%'));

-- Ficha: a qué se dedica, dónde, enlaces y una breve presentación.
alter table public.perfiles add column if not exists ficha jsonb not null default '{}'::jsonb;

grant update (avatar, ficha) on public.perfiles to authenticated;
