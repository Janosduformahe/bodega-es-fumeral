-- ════════════════════════════════════════════════════════════════════
-- FASE 1 — Modelo de permisos "Mi Bodega"
-- ════════════════════════════════════════════════════════════════════

alter table public.perfiles
  add column if not exists activo     boolean     not null default true,
  add column if not exists creado_en  timestamptz not null default now(),
  add column if not exists creado_por uuid        references auth.users(id);

create index if not exists perfiles_admin_activo_idx
  on public.perfiles (rol) where activo;

-- ── 1. Helpers ──────────────────────────────────────────────────────
-- Distingue "una persona con sesión" de "el backend / la propia plataforma".
-- session_user NO cambia dentro de SECURITY DEFINER: a través de la API siempre
-- es 'authenticator', así que ningún usuario del navegador puede caer en la lista.
-- supabase_auth_admin es el rol de GoTrue: sin él, el borrado en cascada desde
-- auth.users chocaría contra el guardián de perfiles y la Admin API no podría
-- borrar a nadie nunca.
create or replace function public.es_servicio()
returns boolean language plpgsql stable set search_path = public as $$
declare claims text;
begin
  if session_user in ('postgres','supabase_admin','supabase_auth_admin','service_role') then
    return true;
  end if;
  claims := current_setting('request.jwt.claims', true);
  if claims is null or claims = '' then return false; end if;
  return (claims::jsonb ->> 'role') = 'service_role';
exception when others then return false;
end $$;

create or replace function public.es_equipo()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfiles where user_id = auth.uid() and activo);
$$;

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from perfiles
    where user_id = auth.uid() and activo and rol = 'admin'
  );
$$;

create or replace function public.mi_perfil()
returns table (user_id uuid, nombre text, rol rol_usuario, activo boolean)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.nombre, p.rol, p.activo
  from perfiles p where p.user_id = auth.uid();
$$;

revoke all on function public.es_servicio() from public;
revoke all on function public.es_equipo()   from public;
revoke all on function public.mi_perfil()   from public;
grant execute on function public.es_servicio() to authenticated, service_role;
grant execute on function public.es_equipo()   to authenticated, service_role;
grant execute on function public.mi_perfil()   to authenticated, service_role;
grant execute on function public.es_admin()    to service_role;

-- ── 2. Guardias de la tabla perfiles ────────────────────────────────
create or replace function public.perfiles_guardia()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  admin    boolean := es_admin();
  servicio boolean := es_servicio();
begin
  if tg_op = 'INSERT' then
    if not (admin or servicio) then
      raise exception 'solo un administrador puede dar de alta usuarios'
        using errcode = '42501';
    end if;
    new.creado_por := coalesce(new.creado_por, auth.uid());
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'el identificador de un perfil no se cambia'
        using errcode = '42501';
    end if;
    if servicio then return new; end if;

    if not admin then
      if new.user_id is distinct from auth.uid() then
        raise exception 'no puedes tocar el perfil de otra persona'
          using errcode = '42501';
      end if;
      if new.rol is distinct from old.rol or new.activo is distinct from old.activo then
        raise exception 'no puedes cambiar tu rol ni el estado de tu cuenta'
          using errcode = '42501';
      end if;
      return new;
    end if;

    if new.user_id = auth.uid() and new.rol is distinct from old.rol then
      raise exception 'no puedes cambiarte el rol a ti mismo: que lo haga otro administrador'
        using errcode = '42501';
    end if;
    if new.user_id = auth.uid() and new.activo is distinct from old.activo then
      raise exception 'no puedes desactivar tu propia cuenta'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if not (admin or servicio) then
    raise exception 'solo un administrador puede borrar usuarios'
      using errcode = '42501';
  end if;
  if old.user_id = auth.uid() then
    raise exception 'no puedes borrar tu propia cuenta'
      using errcode = '42501';
  end if;
  return old;
end $$;

drop trigger if exists perfiles_guardia on public.perfiles;
create trigger perfiles_guardia
  before insert or update or delete on public.perfiles
  for each row execute function public.perfiles_guardia();

create or replace function public.perfiles_ultimo_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from perfiles where rol = 'admin' and activo) then
    raise exception 'la bodega se quedaría sin ningún administrador activo'
      using errcode = '23514';
  end if;
  return null;
end $$;

drop trigger if exists perfiles_ultimo_admin on public.perfiles;
create constraint trigger perfiles_ultimo_admin
  after update or delete on public.perfiles
  deferrable initially deferred
  for each row execute function public.perfiles_ultimo_admin();

-- ── 3. Políticas RLS ────────────────────────────────────────────────
drop policy if exists "equipo lee perfiles"  on public.perfiles;
drop policy if exists "admin crea perfiles"  on public.perfiles;
drop policy if exists "admin edita perfiles" on public.perfiles;

create policy "equipo lee perfiles" on public.perfiles
  for select to authenticated using (public.es_equipo());
create policy "admin crea perfiles" on public.perfiles
  for insert to authenticated with check (public.es_admin());
create policy "perfil editable por admin o por su dueno" on public.perfiles
  for update to authenticated
  using      (public.es_admin() or user_id = auth.uid())
  with check (public.es_admin() or user_id = auth.uid());
create policy "admin borra perfiles" on public.perfiles
  for delete to authenticated using (public.es_admin());

drop policy if exists "equipo lee vinos"  on public.vinos;
drop policy if exists "admin crea vinos"  on public.vinos;
drop policy if exists "admin edita vinos" on public.vinos;

create policy "equipo lee vinos" on public.vinos
  for select to authenticated using (public.es_equipo());
create policy "admin crea vinos" on public.vinos
  for insert to authenticated with check (public.es_admin());
create policy "admin edita vinos" on public.vinos
  for update to authenticated
  using (public.es_admin()) with check (public.es_admin());

drop policy if exists "equipo lee movimientos" on public.movimientos;
create policy "equipo lee movimientos" on public.movimientos
  for select to authenticated using (public.es_equipo());

drop policy if exists "equipo lee alias" on public.alias_carta;
create policy "equipo lee alias" on public.alias_carta
  for select to authenticated using (public.es_equipo());

drop policy if exists "equipo lee documentos"  on public.documentos;
drop policy if exists "equipo crea documentos" on public.documentos;
drop policy if exists "admin borra documentos" on public.documentos;

create policy "equipo lee documentos" on public.documentos
  for select to authenticated using (public.es_equipo());
create policy "equipo sube documentos" on public.documentos
  for insert to authenticated
  with check (public.es_equipo() and user_id = auth.uid() and aplicado = false);
create policy "admin borra documentos" on public.documentos
  for delete to authenticated using (public.es_admin());

drop policy if exists "equipo lee ajustes"  on public.ajustes;
drop policy if exists "equipo edita ajustes" on public.ajustes;

create policy "equipo lee ajustes" on public.ajustes
  for select to authenticated using (public.es_equipo());
create policy "equipo silencia alertas" on public.ajustes
  for update to authenticated
  using      (public.es_equipo() and clave = 'alertas_descartadas')
  with check (clave = 'alertas_descartadas');
create policy "admin edita ajustes" on public.ajustes
  for update to authenticated
  using      (public.es_admin() and clave in ('umbral_stock_bajo','multiplicador_precio','alertas_descartadas'))
  with check (public.es_admin() and clave in ('umbral_stock_bajo','multiplicador_precio','alertas_descartadas'));

-- ── 4. RPCs SECURITY DEFINER con control de rol ─────────────────────
create or replace function public.registrar_movimiento(
  p_vino_id bigint,
  p_tipo tipo_movimiento,
  p_qty integer,
  p_nota text default null,
  p_documento_id bigint default null)
returns vinos
language plpgsql security definer set search_path = public as $$
declare
  v vinos;
  admin boolean;
begin
  admin := es_admin() or es_servicio();
  if not (admin or es_equipo()) then
    raise exception 'tu cuenta no está activa en la bodega' using errcode = '42501';
  end if;

  if not admin then
    if p_tipo not in ('venta','entrada','ajuste') then
      raise exception 'solo el responsable puede registrar movimientos de tipo %', p_tipo
        using errcode = '42501';
    end if;
    if p_tipo = 'ajuste' then
      if p_qty >= 0 or p_qty < -3 then
        raise exception 'un ajuste de sala solo puede restar hasta 3 botellas; para un recuento avisa al responsable'
          using errcode = '42501';
      end if;
      if coalesce(btrim(p_nota), '') = '' then
        raise exception 'un ajuste necesita una nota explicando qué ha pasado'
          using errcode = '42501';
      end if;
    end if;
  end if;

  if p_qty = 0 then
    raise exception 'la cantidad no puede ser 0';
  end if;

  update vinos
     set stock = stock + p_qty
   where id = p_vino_id
  returning * into v;

  if not found then
    raise exception 'vino % no existe', p_vino_id;
  end if;

  insert into movimientos (vino_id, tipo, qty, stock_prev, stock_nuevo, nota,
                           documento_id, user_id, precio_unit, coste_unit)
  values (p_vino_id, p_tipo, p_qty, v.stock - p_qty, v.stock, p_nota,
          p_documento_id, auth.uid(), v.precio, v.precio_compra);

  if not admin then
    v.precio_compra := null;
    v.proveedor     := null;
  end if;
  return v;
end $$;

create or replace function public.aplicar_documento(p_documento_id bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  doc documentos;
  mov jsonb;
  ref jsonb;
  v vinos;
  n_movs int := 0;
  n_nuevas int := 0;
  n_precios int := 0;
  n_carta int := 0;
  n_fuera int := 0;
  ids bigint[];
  mov_tipo tipo_movimiento;
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede aplicar un documento al inventario'
      using errcode = '42501';
  end if;

  select * into doc from documentos where id = p_documento_id for update;
  if not found then
    raise exception 'documento % no existe', p_documento_id;
  end if;
  if doc.aplicado then
    raise exception 'el documento % ya fue aplicado', p_documento_id;
  end if;

  for ref in select * from jsonb_array_elements(coalesce(doc.resultado->'precios', '[]'::jsonb))
  loop
    update vinos
       set precio = case
             when (ref->>'precio_nuevo') is not null and (ref->>'precio_nuevo')::numeric > 0
             then (ref->>'precio_nuevo')::numeric else precio end,
           precio_compra = case
             when (ref->>'precio_compra_nuevo') is not null and (ref->>'precio_compra_nuevo')::numeric > 0
             then (ref->>'precio_compra_nuevo')::numeric else precio_compra end,
           proveedor = coalesce(nullif(ref->>'proveedor_nuevo', ''), proveedor)
     where id = (ref->>'vino_id')::bigint;
    if found then
      n_precios := n_precios + 1;
    end if;
  end loop;

  if doc.tipo = 'carta' then
    select coalesce(array_agg((e)::bigint), '{}')
      into ids
      from jsonb_array_elements_text(coalesce(doc.resultado->'carta_ids', '[]'::jsonb)) e;

    update vinos
       set en_carta = (id = any(ids)), carta_actualizada = now()
     where activo;

    select count(*) filter (where en_carta), count(*) filter (where not en_carta)
      into n_carta, n_fuera
      from vinos where activo;
  end if;

  for mov in select * from jsonb_array_elements(coalesce(doc.resultado->'movimientos', '[]'::jsonb))
  loop
    mov_tipo := case doc.tipo
      when 'albaran' then 'entrada'::tipo_movimiento
      when 'cierre'  then 'venta'::tipo_movimiento
      else 'excel'::tipo_movimiento
    end;
    perform registrar_movimiento(
      (mov->>'vino_id')::bigint,
      mov_tipo,
      (mov->>'qty')::int,
      coalesce(mov->>'nota', doc.nombre_archivo),
      p_documento_id
    );
    n_movs := n_movs + 1;
  end loop;

  for ref in select * from jsonb_array_elements(coalesce(doc.resultado->'nuevas_referencias', '[]'::jsonb))
  loop
    insert into vinos (anio, bodega, nombre, tipo, pais, uva, precio, precio_compra, proveedor, stock, en_carta)
    values (
      (ref->>'anio')::int,
      ref->>'bodega',
      ref->>'nombre',
      (ref->>'tipo')::tipo_vino,
      ref->>'pais',
      ref->>'uva',
      (ref->>'precio')::numeric,
      (ref->>'precio_compra')::numeric,
      nullif(ref->>'proveedor', ''),
      coalesce((ref->>'stock')::int, 0),
      doc.tipo = 'carta'
    ) returning * into v;

    insert into movimientos (vino_id, tipo, qty, stock_prev, stock_nuevo, nota,
                             documento_id, user_id, precio_unit, coste_unit)
    values (v.id,
            case doc.tipo when 'albaran' then 'entrada'::tipo_movimiento else 'excel'::tipo_movimiento end,
            v.stock, 0, v.stock, 'alta desde ' || doc.nombre_archivo,
            p_documento_id, auth.uid(), v.precio, v.precio_compra);
    n_nuevas := n_nuevas + 1;
  end loop;

  update documentos set aplicado = true where id = p_documento_id;

  return jsonb_build_object(
    'movimientos_aplicados', n_movs,
    'referencias_nuevas', n_nuevas,
    'precios_actualizados', n_precios,
    'en_carta', n_carta,
    'fuera_de_carta', n_fuera
  );
end $$;

create or replace function public.aplicar_movimientos(p_documento_id bigint, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  doc documentos;
  it jsonb;
  n_movs int := 0;
  n_alias int := 0;
  mov_tipo tipo_movimiento;
  v_stock int;
  q int;
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede aplicar un cierre al inventario'
      using errcode = '42501';
  end if;

  select * into doc from documentos where id = p_documento_id for update;
  if not found then
    raise exception 'documento % no existe', p_documento_id;
  end if;
  if doc.aplicado then
    raise exception 'el documento % ya fue aplicado', p_documento_id;
  end if;

  mov_tipo := case doc.tipo
    when 'albaran' then 'entrada'::tipo_movimiento
    when 'cierre'  then 'venta'::tipo_movimiento
    else 'excel'::tipo_movimiento
  end;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    q := (it->>'qty')::int;
    if q is null or q = 0 then
      continue;
    end if;
    if q < 0 then
      select stock into v_stock from vinos where id = (it->>'vino_id')::bigint;
      if v_stock is null then continue; end if;
      q := -least(abs(q), v_stock);
      if q = 0 then continue; end if;
    end if;

    perform registrar_movimiento(
      (it->>'vino_id')::bigint,
      mov_tipo,
      q,
      coalesce(nullif(it->>'texto', ''), doc.nombre_archivo),
      p_documento_id
    );
    n_movs := n_movs + 1;

    if coalesce(it->>'texto', '') <> '' then
      insert into alias_carta (texto_norm, vino_id, user_id)
      values (lower(btrim(it->>'texto')), (it->>'vino_id')::bigint, auth.uid())
      on conflict (texto_norm) do update set vino_id = excluded.vino_id;
      n_alias := n_alias + 1;
    end if;
  end loop;

  update documentos
     set aplicado = true,
         resultado = jsonb_set(resultado, '{movimientos_aplicados}', p_items)
   where id = p_documento_id;

  return jsonb_build_object('movimientos_aplicados', n_movs, 'alias_guardados', n_alias);
end $$;

create or replace function public.aplicar_carta(p_documento_id bigint, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  doc documentos;
  it jsonb;
  ids bigint[];
  n_precios int := 0;
  n_alias int := 0;
  n_carta int;
  n_fuera int;
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede publicar la carta'
      using errcode = '42501';
  end if;

  select * into doc from documentos where id = p_documento_id for update;
  if not found then
    raise exception 'documento % no existe', p_documento_id;
  end if;
  if doc.aplicado then
    raise exception 'el documento % ya fue aplicado', p_documento_id;
  end if;
  if doc.tipo <> 'carta' then
    raise exception 'el documento % no es una carta', p_documento_id;
  end if;

  select coalesce(array_agg((it->>'vino_id')::bigint), '{}')
    into ids
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it;

  update vinos
     set en_carta = (id = any(ids)), carta_actualizada = now()
   where activo;

  select count(*) filter (where en_carta), count(*) filter (where not en_carta)
    into n_carta, n_fuera
    from vinos where activo;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    if (it->>'precio') is not null and (it->>'precio')::numeric > 0 then
      update vinos set precio = (it->>'precio')::numeric
       where id = (it->>'vino_id')::bigint
         and precio is distinct from (it->>'precio')::numeric;
      if found then n_precios := n_precios + 1; end if;
    end if;
    if coalesce(it->>'texto', '') <> '' then
      insert into alias_carta (texto_norm, vino_id, user_id)
      values (lower(btrim(it->>'texto')), (it->>'vino_id')::bigint, auth.uid())
      on conflict (texto_norm) do update set vino_id = excluded.vino_id;
      n_alias := n_alias + 1;
    end if;
  end loop;

  update documentos
     set aplicado = true,
         resultado = jsonb_set(resultado, '{carta_ids}', to_jsonb(ids))
   where id = p_documento_id;

  return jsonb_build_object(
    'en_carta', n_carta,
    'fuera_de_carta', n_fuera,
    'precios_actualizados', n_precios,
    'alias_guardados', n_alias
  );
end $$;

create or replace function public.dar_de_baja(p_ids bigint[])
returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede dar de baja referencias'
      using errcode = '42501';
  end if;
  update vinos set activo = false where id = any(p_ids) and activo;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── 5. Gestión de usuarios ──────────────────────────────────────────
create or replace function public.listar_usuarios()
returns table (
  user_id uuid, nombre text, rol rol_usuario, activo boolean,
  email text, creado timestamptz, ultimo_acceso timestamptz,
  bloqueado boolean, tiene_historial boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede ver el equipo' using errcode = '42501';
  end if;
  return query
    select p.user_id, p.nombre, p.rol, p.activo,
           u.email::text, p.creado_en, u.last_sign_in_at,
           (u.banned_until is not null and u.banned_until > now()),
           exists (select 1 from movimientos m where m.user_id = p.user_id)
             or exists (select 1 from documentos d where d.user_id = p.user_id)
      from perfiles p
      join auth.users u on u.id = p.user_id
     order by p.rol, p.nombre;
end $$;

create or replace function public.alta_perfil(
  p_user_id uuid, p_nombre text, p_rol rol_usuario default 'staff')
returns perfiles
language plpgsql security definer set search_path = public as $$
declare fila perfiles;
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede dar de alta usuarios' using errcode = '42501';
  end if;
  if coalesce(btrim(p_nombre), '') = '' then
    raise exception 'el usuario necesita un nombre';
  end if;
  insert into perfiles (user_id, nombre, rol, activo, creado_por)
  values (p_user_id, btrim(p_nombre), p_rol, true, auth.uid())
  on conflict (user_id) do update
    set nombre = excluded.nombre, rol = excluded.rol, activo = true
  returning * into fila;
  return fila;
end $$;

create or replace function public.cambiar_rol(p_user_id uuid, p_rol rol_usuario)
returns perfiles
language plpgsql security definer set search_path = public as $$
declare fila perfiles;
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede cambiar roles' using errcode = '42501';
  end if;
  update perfiles set rol = p_rol where user_id = p_user_id returning * into fila;
  if not found then raise exception 'ese usuario no existe'; end if;
  return fila;
end $$;

create or replace function public.activar_usuario(p_user_id uuid, p_activo boolean)
returns perfiles
language plpgsql security definer set search_path = public as $$
declare fila perfiles;
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede activar o desactivar cuentas' using errcode = '42501';
  end if;
  update perfiles set activo = p_activo where user_id = p_user_id returning * into fila;
  if not found then raise exception 'ese usuario no existe'; end if;
  return fila;
end $$;

create or replace function public.renombrar_usuario(p_user_id uuid, p_nombre text)
returns perfiles
language plpgsql security definer set search_path = public as $$
declare fila perfiles;
begin
  if coalesce(btrim(p_nombre), '') = '' then
    raise exception 'el nombre no puede estar vacío';
  end if;
  if not (es_admin() or es_servicio() or p_user_id = auth.uid()) then
    raise exception 'solo puedes cambiar tu propio nombre' using errcode = '42501';
  end if;
  update perfiles set nombre = btrim(p_nombre) where user_id = p_user_id returning * into fila;
  if not found then raise exception 'ese usuario no existe'; end if;
  return fila;
end $$;

create or replace function public.puede_borrarse_usuario(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  n_mov int; n_doc int; n_alias int; es_ultimo boolean;
begin
  if not (es_admin() or es_servicio()) then
    raise exception 'solo el responsable puede borrar usuarios' using errcode = '42501';
  end if;
  select count(*) into n_mov   from movimientos where user_id = p_user_id;
  select count(*) into n_doc   from documentos  where user_id = p_user_id;
  select count(*) into n_alias from alias_carta where user_id = p_user_id;
  select not exists (
    select 1 from perfiles
     where rol = 'admin' and activo and user_id <> p_user_id
  ) into es_ultimo;

  return jsonb_build_object(
    'puede', (n_mov + n_doc + n_alias) = 0
             and not es_ultimo
             and p_user_id is distinct from auth.uid(),
    'movimientos', n_mov,
    'documentos', n_doc,
    'alias', n_alias,
    'es_ultimo_admin', es_ultimo,
    'es_uno_mismo', p_user_id is not distinct from auth.uid(),
    'motivo', case
      when p_user_id is not distinct from auth.uid() then 'no puedes borrarte a ti mismo'
      when es_ultimo then 'es el único administrador activo'
      when (n_mov + n_doc + n_alias) > 0 then 'tiene historial en la bodega: desactívalo en vez de borrarlo'
      else null end
  );
end $$;

revoke all on function public.listar_usuarios()                          from public;
revoke all on function public.alta_perfil(uuid, text, rol_usuario)       from public;
revoke all on function public.cambiar_rol(uuid, rol_usuario)             from public;
revoke all on function public.activar_usuario(uuid, boolean)             from public;
revoke all on function public.renombrar_usuario(uuid, text)              from public;
revoke all on function public.puede_borrarse_usuario(uuid)               from public;
grant execute on function public.listar_usuarios()                       to authenticated, service_role;
grant execute on function public.alta_perfil(uuid, text, rol_usuario)    to authenticated, service_role;
grant execute on function public.cambiar_rol(uuid, rol_usuario)          to authenticated, service_role;
grant execute on function public.activar_usuario(uuid, boolean)          to authenticated, service_role;
grant execute on function public.renombrar_usuario(uuid, text)           to authenticated, service_role;
grant execute on function public.puede_borrarse_usuario(uuid)            to authenticated, service_role;

-- ── 6. Storage ──────────────────────────────────────────────────────
drop policy if exists "equipo lee documentos"  on storage.objects;
drop policy if exists "equipo sube documentos" on storage.objects;
drop policy if exists "admin borra documentos" on storage.objects;

create policy "equipo lee documentos" on storage.objects
  for select to authenticated
  using (bucket_id = 'documentos' and public.es_equipo());
create policy "equipo sube documentos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documentos' and public.es_equipo());
create policy "admin borra documentos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documentos' and public.es_admin());
