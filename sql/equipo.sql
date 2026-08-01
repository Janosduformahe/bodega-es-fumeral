-- ═══════════════════════════════════════════════════════════════════════
--  Gestión de equipo: 1 anfitrión + hasta 3 usuarios
--
--  Modelo elegido: los usuarios pueden hacer TODO lo que hace el anfitrión
--  salvo administrar cuentas. Las políticas antiguas decían otra cosa (sólo
--  admin escribía en vinos) pero eran papel mojado: las RPC SECURITY DEFINER
--  se saltan RLS y sólo comprobaban que hubiera sesión. Aquí se alinea lo
--  declarado con lo real.
--
--  Las cuentas se crean desde Postgres, sin service role key: así no hace
--  falta guardar otro secreto en Vercel. Verificado que la cuenta resultante
--  inicia sesión con la clave pública.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1 · Un usuario borrado no debe llevarse el historial por delante ──
-- Hoy las tres claves son NO ACTION, así que borrar a alguien que haya
-- tocado algo es imposible. Con SET NULL la fila se queda y pierde el autor.
alter table public.documentos   drop constraint if exists documentos_user_id_fkey;
alter table public.movimientos  drop constraint if exists movimientos_user_id_fkey;
alter table public.alias_carta  drop constraint if exists alias_carta_user_id_fkey;

alter table public.documentos  add constraint documentos_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
alter table public.movimientos add constraint movimientos_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
alter table public.alias_carta add constraint alias_carta_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- ── 2 · Tener sesión NO basta: hay que ser del equipo ──
-- Comprobado en producción: el registro público estaba abierto y con la clave
-- que va en el navegador cualquiera podía crearse una cuenta. Como todas las
-- políticas eran `to authenticated using (true)`, esa cuenta leía el catálogo
-- entero con precios de compra, los documentos y el bucket. Con es_equipo()
-- un extraño con sesión no ve absolutamente nada.
create or replace function public.es_equipo()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from perfiles where user_id = auth.uid());
$$;

grant execute on function public.es_equipo() to authenticated;
grant execute on function public.es_admin()  to authenticated;

-- vinos: el equipo lee y escribe igual que el anfitrión
drop policy if exists "admin crea vinos"    on public.vinos;
drop policy if exists "admin edita vinos"   on public.vinos;
drop policy if exists "equipo lee vinos"    on public.vinos;
create policy "equipo lee vinos"   on public.vinos for select to authenticated using (es_equipo());
create policy "equipo crea vinos"  on public.vinos for insert to authenticated with check (es_equipo());
create policy "equipo edita vinos" on public.vinos for update to authenticated
  using (es_equipo()) with check (es_equipo());

drop policy if exists "equipo lee movimientos" on public.movimientos;
create policy "equipo lee movimientos" on public.movimientos for select to authenticated using (es_equipo());

drop policy if exists "equipo lee documentos"   on public.documentos;
drop policy if exists "equipo crea documentos"  on public.documentos;
drop policy if exists "equipo borra documentos" on public.documentos;
create policy "equipo lee documentos"  on public.documentos for select to authenticated using (es_equipo());
create policy "equipo crea documentos" on public.documentos for insert to authenticated
  with check (es_equipo() and auth.uid() = user_id);
-- sin DELETE, el deduplicador del cierre del TPV borraba 0 filas en silencio y
-- la noche podía descontarse dos veces
create policy "equipo borra documentos" on public.documentos for delete to authenticated
  using (es_equipo() and not aplicado);

drop policy if exists "equipo lee alias" on public.alias_carta;
create policy "equipo lee alias" on public.alias_carta for select to authenticated using (es_equipo());

drop policy if exists "equipo lee ajustes"   on public.ajustes;
drop policy if exists "equipo edita ajustes" on public.ajustes;
create policy "equipo lee ajustes" on public.ajustes for select to authenticated using (es_equipo());
create policy "equipo edita ajustes" on public.ajustes for update to authenticated
  using (es_equipo() and clave = any (array['umbral_stock_bajo','alertas_descartadas','multiplicador_precio']))
  with check (es_equipo() and clave = any (array['umbral_stock_bajo','alertas_descartadas','multiplicador_precio']));

drop policy if exists "equipo lee perfiles" on public.perfiles;
create policy "equipo lee perfiles" on public.perfiles for select to authenticated using (es_equipo());

-- el bucket guarda los albaranes originales, con precios de compra dentro
drop policy if exists "equipo lee documentos"  on storage.objects;
drop policy if exists "equipo sube documentos" on storage.objects;
create policy "equipo lee documentos" on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and es_equipo());
create policy "equipo sube documentos" on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos' and es_equipo());

-- dar_de_baja dejaba fuera al equipo; ahora sólo exige sesión
create or replace function public.dar_de_baja(p_ids bigint[])
returns integer language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  if auth.uid() is null then
    raise exception 'no autenticado';
  end if;
  update vinos set activo = false where id = any(p_ids) and activo;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── 3 · Tope de cuentas, configurable y no esquivable desde el navegador ──
insert into public.ajustes (clave, valor)
  values ('max_usuarios', '4')
  on conflict (clave) do nothing;

create or replace function public.limite_de_cuentas()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare tope int;
begin
  -- el lock evita que dos altas simultáneas se cuelen a la vez
  perform pg_advisory_xact_lock(hashtext('perfiles_tope'));
  -- ajustes.valor es jsonb: #>> '{}' lo saca como texto plano
  select coalesce(nullif(valor #>> '{}', ''), '4')::int into tope
    from ajustes where clave = 'max_usuarios';
  if (select count(*) from perfiles) >= coalesce(tope, 4) then
    raise exception 'limite de cuentas alcanzado (%). Borra o reutiliza una existente.', tope;
  end if;
  return new;
end $$;

drop trigger if exists trg_limite_de_cuentas on public.perfiles;
create trigger trg_limite_de_cuentas
  before insert on public.perfiles
  for each row execute function public.limite_de_cuentas();

-- ── 4 · Nunca quedarse sin anfitrión ──
create or replace function public.proteger_ultimo_anfitrion()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare quedan int;
begin
  if tg_op = 'UPDATE' and old.rol = 'admin' and new.rol <> 'admin' then
    select count(*) into quedan from perfiles where rol = 'admin' and user_id <> old.user_id;
    if quedan = 0 then
      raise exception 'no puedes quitar el ultimo anfitrion: la bodega quedaria sin administrador';
    end if;
  end if;
  if tg_op = 'DELETE' and old.rol = 'admin' then
    select count(*) into quedan from perfiles where rol = 'admin' and user_id <> old.user_id;
    if quedan = 0 then
      raise exception 'no puedes borrar el ultimo anfitrion';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists trg_proteger_ultimo_anfitrion on public.perfiles;
create trigger trg_proteger_ultimo_anfitrion
  before update or delete on public.perfiles
  for each row execute function public.proteger_ultimo_anfitrion();

-- ── 5 · Listado del equipo (junta perfiles con los datos de acceso) ──
create or replace function public.equipo_listar()
returns table (
  user_id uuid, nombre text, rol text, email text,
  ultimo_acceso timestamptz, alta timestamptz, activo boolean, soy_yo boolean
) language sql security definer set search_path to 'public' as $$
  select p.user_id, p.nombre, p.rol::text, u.email::text,
         u.last_sign_in_at, u.created_at,
         (u.banned_until is null or u.banned_until < now()) as activo,
         p.user_id = auth.uid() as soy_yo
  from perfiles p join auth.users u on u.id = p.user_id
  where es_admin()
  order by (p.rol = 'admin') desc, p.nombre;
$$;

-- ── 6 · Alta de una cuenta ──
create or replace function public.equipo_crear(
  p_nombre text, p_email text, p_password text, p_rol text default 'staff'
) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare uid uuid := gen_random_uuid();
begin
  if not es_admin() then
    raise exception 'solo el anfitrion puede crear cuentas';
  end if;
  if coalesce(trim(p_nombre), '') = '' then
    raise exception 'hace falta un nombre';
  end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'el usuario debe tener forma de correo';
  end if;
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'la contrasena debe tener al menos 10 caracteres';
  end if;
  if p_rol not in ('admin', 'staff') then
    raise exception 'rol no valido';
  end if;
  if exists (select 1 from auth.users where lower(email) = lower(p_email)) then
    raise exception 'ya existe una cuenta con ese usuario';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    lower(p_email), extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}',
    jsonb_build_object('nombre', trim(p_nombre)), now(), now(), '', '', '', ''
  );
  insert into auth.identities (id, user_id, provider_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text,
    jsonb_build_object('sub', uid::text, 'email', lower(p_email), 'email_verified', true),
    'email', now(), now(), now());

  -- el trigger del tope salta aquí si ya se llegó al máximo
  insert into perfiles (user_id, nombre, rol) values (uid, trim(p_nombre), p_rol::rol_usuario);
  return uid;
end $$;

-- ── 7 · Renombrar ──
create or replace function public.equipo_renombrar(p_user_id uuid, p_nombre text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not es_admin() then raise exception 'solo el anfitrion puede editar cuentas'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'hace falta un nombre'; end if;
  update perfiles set nombre = trim(p_nombre) where user_id = p_user_id;
end $$;

-- ── 8 · Cambiar de rol ──
create or replace function public.equipo_cambiar_rol(p_user_id uuid, p_rol text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not es_admin() then raise exception 'solo el anfitrion puede cambiar roles'; end if;
  if p_rol not in ('admin', 'staff') then raise exception 'rol no valido'; end if;
  if p_user_id = auth.uid() and p_rol <> 'admin' then
    raise exception 'no puedes quitarte a ti mismo el papel de anfitrion';
  end if;
  update perfiles set rol = p_rol::rol_usuario where user_id = p_user_id;
end $$;

-- ── 9 · Contraseña nueva ──
create or replace function public.equipo_password(p_user_id uuid, p_password text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not es_admin() then raise exception 'solo el anfitrion puede cambiar contrasenas'; end if;
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'la contrasena debe tener al menos 10 caracteres';
  end if;
  if not exists (select 1 from perfiles where user_id = p_user_id) then
    raise exception 'esa cuenta no es del equipo';
  end if;
  -- un anfitrion no puede cambiarle la clave a otro anfitrion y entrar como el
  if p_user_id <> auth.uid()
     and (select rol from perfiles where user_id = p_user_id) = 'admin' then
    raise exception 'no puedes cambiar la contrasena de otro anfitrion';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = p_user_id;
  -- que tenga que volver a entrar con la nueva
  delete from auth.sessions where user_id = p_user_id;
end $$;

-- ── 10 · Desactivar y reactivar ──
create or replace function public.equipo_activar(p_user_id uuid, p_activo boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not es_admin() then raise exception 'solo el anfitrion puede desactivar cuentas'; end if;
  if p_user_id = auth.uid() and not p_activo then
    raise exception 'no puedes desactivarte a ti mismo';
  end if;
  if not exists (select 1 from perfiles where user_id = p_user_id) then
    raise exception 'esa cuenta no es del equipo';
  end if;
  if not p_activo and (select rol from perfiles where user_id = p_user_id) = 'admin'
     and (select count(*) from perfiles where rol = 'admin' and user_id <> p_user_id) = 0 then
    raise exception 'no puedes desactivar al ultimo anfitrion';
  end if;
  update auth.users
     set banned_until = case when p_activo then null else now() + interval '100 years' end,
         updated_at = now()
   where id = p_user_id;
  if not p_activo then
    delete from auth.sessions where user_id = p_user_id;
  end if;
end $$;

-- ── 11 · Borrar de verdad (el historial se conserva, sin autor) ──
create or replace function public.equipo_borrar(p_user_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not es_admin() then raise exception 'solo el anfitrion puede borrar cuentas'; end if;
  if p_user_id = auth.uid() then
    raise exception 'no puedes borrar tu propia cuenta';
  end if;
  if not exists (select 1 from perfiles where user_id = p_user_id) then
    raise exception 'esa cuenta no es del equipo';
  end if;
  -- perfiles va en CASCADE y el trigger del ultimo anfitrion vigila el borrado
  delete from auth.users where id = p_user_id;
end $$;

-- ── 12 · Sólo un usuario con sesión puede llamarlas; dentro se exige anfitrión ──
revoke all on function public.equipo_listar()                       from public, anon;
revoke all on function public.equipo_crear(text, text, text, text)  from public, anon;
revoke all on function public.equipo_renombrar(uuid, text)          from public, anon;
revoke all on function public.equipo_cambiar_rol(uuid, text)        from public, anon;
revoke all on function public.equipo_password(uuid, text)           from public, anon;
revoke all on function public.equipo_activar(uuid, boolean)         from public, anon;
revoke all on function public.equipo_borrar(uuid)                   from public, anon;

grant execute on function public.equipo_listar()                      to authenticated;
grant execute on function public.equipo_crear(text, text, text, text) to authenticated;
grant execute on function public.equipo_renombrar(uuid, text)         to authenticated;
grant execute on function public.equipo_cambiar_rol(uuid, text)       to authenticated;
grant execute on function public.equipo_password(uuid, text)          to authenticated;
grant execute on function public.equipo_activar(uuid, boolean)        to authenticated;
grant execute on function public.equipo_borrar(uuid)                  to authenticated;
