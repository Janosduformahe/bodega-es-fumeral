// Emite el SQL para reactivar bajas que vuelven a tener botellas en el excel
// y crear las referencias nuevas, con los datos (precios, proveedor) del excel.
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
const esc = (s: string | null) => (s === null || s === undefined ? "null" : "'" + String(s).replace(/'/g, "''") + "'");
(async () => {
  const buf = fs.readFileSync(path.join(__dirname, "..", "..", "downloadbyjanos", "Copia de INVENTARIO BUENO bueno buenisimo_.xlsx"));
  const { filas } = parsearInventario(buf)!;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  await supabase.auth.signInWithPassword({ email: "equipo@esfumeral.com", password: "EsFumeral2026!" });
  const { data: act } = await supabase.from("vinos").select("*").eq("activo", true);
  const { data: inact } = await supabase.from("vinos").select("*").eq("activo", false);
  const { filasSueltas } = emparejar(filas, (act ?? []) as Vino[]);
  const conStock = filasSueltas.filter(f => !f.sinCantidad && f.stock > 0);
  const { emparejados: enBajas } = emparejar(conStock, (inact ?? []) as Vino[]);
  const nuevas = conStock.filter(f => !enBajas.some(e => e.fila.fila === f.fila));

  const out: string[] = [];
  for (const e of enBajas)
    out.push(`select reactivar(${e.vino.id}, ${e.fila.stock}, ${e.fila.precioVenta ?? "null"}, ${e.fila.precioCompra ?? "null"}, ${esc(e.fila.proveedor)});`);
  for (const f of nuevas) {
    const pv = f.precioVenta ?? (f.precioCompra ? Math.round(f.precioCompra * 1.8) : null);
    out.push(`select crear(${esc(f.bodega)}, ${esc(f.nombre + (f.talla ? " " + f.talla : ""))}, ${f.anio ?? "null"}, ${f.stock}, ${pv ?? "null"}, ${f.precioCompra ?? "null"}, ${esc(f.proveedor)});`);
  }
  fs.writeFileSync(path.join(__dirname, "completar.sql"), out.join("\n"), "utf8");
  console.log(out.join("\n"));
})();
