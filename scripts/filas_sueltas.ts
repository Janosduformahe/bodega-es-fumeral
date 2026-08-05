// ¿Las filas del excel que no casan con activas están entre las dadas de baja?
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
  const { data: act } = await supabase.from("vinos").select("*").eq("activo", true);
  const { data: inact } = await supabase.from("vinos").select("*").eq("activo", false);
  const { filasSueltas } = emparejar(filas, (act ?? []) as Vino[]);
  const conStock = filasSueltas.filter(f => !f.sinCantidad && f.stock > 0);
  const sinStock = filasSueltas.length - conStock.length;
  // ¿casan con las INACTIVAS?
  const { emparejados: enBajas } = emparejar(conStock, (inact ?? []) as Vino[]);
  console.log("filas del excel sin referencia activa:", filasSueltas.length,
    "| con botellas:", conStock.length, "| sin cantidad o a 0:", sinStock);
  console.log("de las que tienen botellas, casan con referencias DADAS DE BAJA:", enBajas.length, "\n");
  for (const e of enBajas)
    console.log(`  ${String(e.fila.stock).padStart(3)} bot · ${e.fila.bodega} — ${e.fila.nombre} (${e.fila.anio ?? "s/a"})  → baja id ${e.vino.id}`);
  const sinNada = conStock.filter(f => !enBajas.some(e => e.fila.fila === f.fila));
  console.log("\nno están NI en bajas (serían referencias nuevas):", sinNada.length);
  sinNada.forEach(f => console.log(`  ${String(f.stock).padStart(3)} bot · ${f.bodega} — ${f.nombre} (${f.anio ?? "s/a"})`));
})();
