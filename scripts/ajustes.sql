
do $$
declare doc_aj bigint; r record; v_prev int;
begin
  insert into documentos (tipo, nombre_archivo, modelo_ia, resultado, aplicado, user_id)
  values ('excel','Reimportación inventario 02/08/2026 (corrección)','determinista, sin IA',
    jsonb_build_object('proveedor_o_fecha','Foto del 02/08 + movimientos posteriores','movimientos','[]'::jsonb),
    true, null) returning id into doc_aj;
  for r in select * from (values (861,17)) as t(vino_id, objetivo)
  loop
    select stock into v_prev from vinos where id = r.vino_id for update;
    if v_prev is null or v_prev = r.objetivo then continue; end if;
    update vinos set stock = r.objetivo, updated_at = now() where id = r.vino_id;
    insert into movimientos (vino_id, tipo, qty, stock_prev, stock_nuevo, nota, documento_id, user_id)
    values (r.vino_id,'excel', r.objetivo - v_prev, v_prev, r.objetivo,
            'Reimportación inventario 02/08 (foto + ventas y entradas posteriores)', doc_aj, null);
  end loop;
end $$;