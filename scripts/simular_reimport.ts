// Simula la reimportación del excel de agosto contra la BD real. NO escribe.
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
  const res = parsearInventario(buf);
  if (!res) { console.log("estructura no reconocida"); return; }
  const { filas, etiquetaFecha } = res;
  console.log("columna de stock detectada:", etiquetaFecha);
  console.log("filas de vino en el excel:", filas.length);

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  await supabase.auth.signInWithPassword({ email: "equipo@esfumeral.com", password: "EsFumeral2026!" });
  const { data } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (data ?? []) as Vino[];
  console.log("catalogo activo:", vinos.length);

  const { emparejados, filasSueltas, vinosSueltos, filasRepetidas } = emparejar(filas, vinos);
  let iguales = 0, difieren = 0, sinCant = 0, dif = 0, difAbs = 0;
  const top: { d: number; txt: string }[] = [];
  for (const e of emparejados) {
    if (e.fila.sinCantidad) { sinCant++; continue; }
    const d = e.fila.stock - e.vino.stock;
    if (d === 0) iguales++;
    else {
      difieren++; dif += d; difAbs += Math.abs(d);
      top.push({ d, txt: `  ${String(d).padStart(4)}  ${e.vino.bodega} — ${e.vino.nombre} (${e.vino.anio ?? "s/a"}): app ${e.vino.stock} → excel ${e.fila.stock}` });
    }
  }
  top.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log("\nemparejados:", emparejados.length, "| filas sin casar (serian nuevas):", filasSueltas.length, "| repetidas en excel:", filasRepetidas.length);
  console.log("stock IGUAL:", iguales, "| DIFIERE:", difieren, "| sin cantidad en excel:", sinCant);
  console.log("delta neto si se aplica:", dif, "botellas | suma de |dif|:", difAbs);
  console.log("\nmayores diferencias (excel − app):");
  top.slice(0, 20).forEach((t) => console.log(t.txt));
  const conStock = vinosSueltos.filter(v => v.stock > 0);
  console.log("\nactivas con stock que NO estan en el excel:", conStock.length,
    "(" + conStock.reduce((s, v) => s + v.stock, 0) + " botellas)");
  console.log("\nfilas sueltas de muestra:", filasSueltas.slice(0, 6).map(f => f.bodega + " | " + f.nombre + " (" + (f.anio ?? "s/a") + ")").join("\n  "));
})();
