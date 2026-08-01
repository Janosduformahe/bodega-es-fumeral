-- ════════════════════════════════════════════════════════════════════
-- FASE 2 — El coste y el margen dejan de estar al alcance de la sala.
-- NO APLICAR SIN LOS CAMBIOS DE CÓDIGO QUE VAN AL FINAL DE ESTE FICHERO.
-- ════════════════════════════════════════════════════════════════════
-- Postgres no tiene RLS por columna, y en Supabase todo el equipo comparte
-- el mismo rol de base de datos ('authenticated'), así que GRANT por columna
-- tampoco sirve: o se lo quitas a todos o a ninguno. La única forma real de
-- enmascarar el coste es servir los datos por vistas y cerrar la tabla.

create or replace view public.v_vinos as
select v.id, v.anio, v.bodega, v.nombre, v.tipo, v.pais, v.uva,
       v.precio, v.stock, v.activo, v.en_carta, v.carta_actualizada,
       v.created_at, v.updated_at,
       case when public.es_admin() then v.precio_compra end as precio_compra,
       case when public.es_admin() then v.proveedor     end as proveedor
  from public.vinos v
 where public.es_equipo();

create or replace view public.v_movimientos as
select m.id, m.vino_id, m.tipo, m.qty, m.stock_prev, m.stock_nuevo, m.nota,
       m.documento_id, m.user_id, m.created_at, m.historico, m.precio_unit,
       case when public.es_admin() then m.coste_unit end as coste_unit,
       v.bodega, v.nombre, v.anio,
       p.nombre as autor
  from public.movimientos m
  join public.vinos v      on v.id = m.vino_id
  left join public.perfiles p on p.user_id = m.user_id
 where public.es_equipo();

-- El resultado de un albarán lleva dentro los precios de compra: la sala ve
-- que el documento existe y en qué estado está, pero no lo que dice.
create or replace view public.v_documentos as
select d.id, d.tipo, d.nombre_archivo, d.modelo_ia, d.aplicado,
       d.created_at, d.user_id,
       case when public.es_admin() then d.resultado end as resultado
  from public.documentos d
 where public.es_equipo();

-- security_invoker = off (el valor por omisión, explícito para que se lea):
-- la vista se ejecuta como su propietario y se salta la RLS de la tabla base;
-- por eso cada vista lleva su propio "where es_equipo()".
alter view public.v_vinos       set (security_invoker = off);
alter view public.v_movimientos set (security_invoker = off);
alter view public.v_documentos  set (security_invoker = off);

-- Se cierra la puerta de atrás: sin esto la sala sigue pudiendo pedir
-- /rest/v1/vinos?select=precio_compra directamente.
revoke select on public.vinos       from authenticated, anon;
revoke select on public.movimientos from authenticated, anon;
revoke select on public.documentos  from authenticated, anon;
revoke insert on public.documentos  from authenticated, anon;
drop policy if exists "equipo sube documentos" on public.documentos;

grant select on public.v_vinos, public.v_movimientos, public.v_documentos
  to authenticated;

-- Los documentos pasan a crearse solo desde el servidor con la clave de
-- servicio. Esto cierra además el agujero de "documento con resultado
-- falsificado": el JSON que aplica el host ya no lo escribe el navegador.

-- ── Cambios de código que acompañan a esta fase ─────────────────────
-- app/page.tsx            : from("vinos")       -> from("v_vinos")
--                           from("movimientos") -> from("v_movimientos")
--                           el .update({activo:false}) -> rpc("dar_de_baja")
-- app/compras/page.tsx    : from("vinos")/from("movimientos") -> vistas
-- app/ventas/page.tsx     : idem
-- app/historial/page.tsx  : from("movimientos").select("*, vinos(...)")
--                           -> from("v_movimientos").select("*")
--                           (la vista ya trae bodega, nombre, anio y autor)
-- app/documentos/page.tsx : from("documentos") -> from("v_documentos")
--                           from("vinos")      -> from("v_vinos")
-- app/api/documentos/route.ts        : leer el catálogo y crear el documento
--                                      con el cliente de servicio, tras
--                                      comprobar la sesión con getUser()
-- app/api/tpv/sincronizar/route.ts   : usar el cliente de servicio también en
--                                      la rama con sesión (hoy su .delete()
--                                      de cierres pendientes no borra nada
--                                      porque no hay política de DELETE)
-- lib/types.ts            : precio_compra/proveedor/coste_unit pasan a ser
--                           opcionales (null para la sala)
