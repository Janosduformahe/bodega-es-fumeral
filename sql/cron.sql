-- ═══════════════════════════════════════════════════════════════════════
--  El cron nocturno del TPV, sin service role key
--
--  La alternativa habitual es guardar SUPABASE_SERVICE_ROLE_KEY en Vercel,
--  pero esa clave se salta la RLS de TODAS las tablas: si se filtra, da
--  acceso completo a la base de datos. Aquí el cron sólo puede hacer dos
--  cosas concretas, y para hacerlas tiene que demostrar que conoce el mismo
--  CRON_SECRET que ya usa Vercel en la cabecera Authorization.
-- ═══════════════════════════════════════════════════════════════════════

-- Con RLS activada y SIN ninguna política: PostgREST no puede leerla ni con
-- la clave pública ni con sesión de usuario. Sólo la ven las funciones
-- SECURITY DEFINER de más abajo, que corren como su propietario.
create table if not exists public.config_privada (
  clave text primary key,
  valor text not null
);
alter table public.config_privada enable row level security;
revoke all on public.config_privada from anon, authenticated;

-- El secreto se guarda con:
--   insert into config_privada (clave, valor) values ('cron_secret', '…')
--     on conflict (clave) do update set valor = excluded.valor;
-- y debe coincidir con la variable CRON_SECRET de Vercel.

create or replace function public.cron_ok(p_secreto text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_secreto is not null
     and length(p_secreto) >= 20
     and exists (select 1 from config_privada where clave = 'cron_secret' and valor = p_secreto);
$$;

/** Catálogo que necesita el cron para casar las ventas del TPV */
create or replace function public.cron_catalogo(p_secreto text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not cron_ok(p_secreto) then raise exception 'no autorizado'; end if;
  return jsonb_build_object(
    'vinos', coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from vinos v where v.activo), '[]'::jsonb),
    'alias', coalesce((select jsonb_agg(jsonb_build_object('texto_norm', a.texto_norm, 'vino_id', a.vino_id))
                       from alias_carta a), '[]'::jsonb)
  );
end $$;

/** Deja el cierre del día PENDIENTE de revisión. Nunca toca el stock:
 *  eso sigue exigiendo que una persona lo apruebe desde la app. */
create or replace function public.cron_guardar_cierre(p_secreto text, p_nombre text, p_resultado jsonb)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare id_doc bigint;
begin
  if not cron_ok(p_secreto) then raise exception 'no autorizado'; end if;
  -- un cierre por día: si ya había uno sin aplicar, se reemplaza
  delete from documentos where tipo = 'cierre' and nombre_archivo = p_nombre and not aplicado;
  insert into documentos (tipo, nombre_archivo, modelo_ia, resultado, user_id)
  values ('cierre', p_nombre, 'HioPOS Analytics · casado en código', p_resultado, null)
  returning id into id_doc;
  return id_doc;
end $$;

-- cron_ok no se expone: sólo se usa desde dentro de las otras dos
revoke all on function public.cron_ok(text) from public, anon, authenticated;
revoke all on function public.cron_catalogo(text) from public;
revoke all on function public.cron_guardar_cierre(text, text, jsonb) from public;

-- El cron llega sin sesión, así que actúa como 'anon'. La barrera no es el
-- rol: es el secreto que se comprueba dentro de cada función.
grant execute on function public.cron_catalogo(text) to anon;
grant execute on function public.cron_guardar_cierre(text, text, jsonb) to anon;
