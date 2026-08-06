// Genera el SQL de ajuste: objetivo = foto del excel (02/08) + movimientos
// posteriores reales (ventas TPV, albaranes) — excluyendo el doc 31 revertido.
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).replace(/^\uFEFF/, "").trim()] = l.slice(i + 1).trim();
}
import { parsearInventario, emparejar } from "../lib/excel";
import type { Vino } from "../lib/types";

(async () => {
  const buf = fs.readFileSync(path.join(__dirname, "..", "..", "downloadbyjanos", "Copia de INVENTARIO BUENO bueno buenisimo_.xlsx"));
  const { filas } = parsearInventario(buf)!;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  await supabase.auth.signInWithPassword({ email: "equipo@esfumeral.com", password: "EsFumeral2026!" });
  const { data } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (data ?? []) as Vino[];

  // movimientos posteriores a la foto (tras los imports del 2/8 a las 11:22),
  // sin el doc 31 (revertido) ni la propia reversión (tipo ajuste con esa nota)
  const { data: movs } = await supabase
    .from("movimientos")
    .select("vino_id, qty, documento_id, nota, tipo, created_at")
    .gte("created_at", "2026-08-02T11:30:00Z")
    .eq("historico", false)
    .limit(10000);
  const delta = new Map<number, number>();
  for (const m of movs ?? []) {
    if (m.documento_id === 31) continue;
    if ((m.nota ?? "").startsWith("Reversión de entrada fantasma")) continue;
    if ((m.nota ?? "").startsWith("Reimportación inventario 02/08")) continue;
    if ((m.nota ?? "").startsWith("Alta desde el inventario 02/08")) continue;
    if ((m.nota ?? "").startsWith("Reactivada: vuelve a contarse")) continue;
    // Las fusiones mueven botellas que YA están en la foto del excel (venían
    // de una referencia duplicada creada por el propio excel): no son delta.
    if ((m.nota ?? "").startsWith("Fusión de referencia duplicada")) continue;
    if ((m.nota ?? "").startsWith("Corrección: la fusión del 04/08")) continue;
    delta.set(m.vino_id, (delta.get(m.vino_id) ?? 0) + m.qty);
  }

  const { emparejados } = emparejar(filas, vinos);
  const ajustes: { id: number; de: number; a: number; nombre: string }[] = [];
  for (const e of emparejados) {
    if (e.fila.sinCantidad) continue;
    const objetivo = Math.max(0, e.fila.stock + (delta.get(e.vino.id) ?? 0));
    if (objetivo !== e.vino.stock)
      ajustes.push({ id: e.vino.id, de: e.vino.stock, a: objetivo, nombre: `${e.vino.bodega} — ${e.vino.nombre}` });
  }
  ajustes.sort((x, y) => Math.abs(y.a - y.de) - Math.abs(x.a - x.de));
  console.log("ajustes necesarios:", ajustes.length,
    "| neto:", ajustes.reduce((s, a) => s + (a.a - a.de), 0),
    "| |dif|:", ajustes.reduce((s, a) => s + Math.abs(a.a - a.de), 0));
  ajustes.slice(0, 12).forEach(a => console.log(`  ${String(a.a - a.de).padStart(4)}  ${a.nombre}: ${a.de} → ${a.a}`));
  const values = ajustes.map(a => `(${a.id},${a.a})`).join(",");
  fs.writeFileSync(path.join(__dirname, "ajustes.sql"), values ? `
do $$
declare doc_aj bigint; r record; v_prev int;
begin
  insert into documentos (tipo, nombre_archivo, modelo_ia, resultado, aplicado, user_id)
  values ('excel','Reimportación inventario 02/08/2026 (corrección)','determinista, sin IA',
    jsonb_build_object('proveedor_o_fecha','Foto del 02/08 + movimientos posteriores','movimientos','[]'::jsonb),
    true, null) returning id into doc_aj;
  for r in select * from (values ${values}) as t(vino_id, objetivo)
  loop
    select stock into v_prev from vinos where id = r.vino_id for update;
    if v_prev is null or v_prev = r.objetivo then continue; end if;
    update vinos set stock = r.objetivo, updated_at = now() where id = r.vino_id;
    insert into movimientos (vino_id, tipo, qty, stock_prev, stock_nuevo, nota, documento_id, user_id)
    values (r.vino_id,'excel', r.objetivo - v_prev, v_prev, r.objetivo,
            'Reimportación inventario 02/08 (foto + ventas y entradas posteriores)', doc_aj, null);
  end loop;
end $$;` : "-- sin ajustes", "utf8");
  console.log("\nSQL escrito en scripts/ajustes.sql");
})();
