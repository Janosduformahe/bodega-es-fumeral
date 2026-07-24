// ¿Cuántas filas emparejadas tienen la celda de cantidad VACÍA (no 0)?
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { emparejar, parsearInventario } from "../lib/excel";
import type { Vino } from "../lib/types";

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const RUTA = "C:/Users/junto/Desktop/BRUXI MAXXX/downloadbyjanos/Copia de INVENTARIO BUENO bueno buenisimo (1).xlsx";

(async () => {
  // Recalcular "celda vacía" leyendo el libro directamente
  const wb = XLSX.readFile(RUTA);
  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets["VINO"], { header: 1 });
  const hdr = rows[0];
  const iJun = hdr.indexOf(46174 as never);
  const vacias = new Set<number>();
  for (let r = 1; r < rows.length; r++) {
    const v = (rows[r] ?? [])[iJun];
    if (v === undefined || v === null || v === "") vacias.add(r + 1);
  }

  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await supabase.auth.signInWithPassword({ email: "equipo@esfumeral.com", password: "EsFumeral2026!" });
  const { data } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (data ?? []) as Vino[];

  const inv = parsearInventario(fs.readFileSync(RUTA));
  if (!inv) throw new Error("parse fail");
  const { emparejados, filasSueltas, vinosSueltos } = emparejar(inv.filas, vinos);

  const empVacias = emparejados.filter((e) => vacias.has(e.fila.fila));
  const empVaciasConStock = empVacias.filter((e) => e.vino.stock > 0);
  console.log(`emparejados: ${emparejados.length}`);
  console.log(`  con celda de junio VACÍA: ${empVacias.length}`);
  console.log(`  de esos, con stock >0 en la app: ${empVaciasConStock.length} (suman ${empVaciasConStock.reduce((s, e) => s + e.vino.stock, 0)} botellas)`);
  empVaciasConStock.slice(0, 8).forEach((e) => console.log(`    - ${e.vino.bodega} ${e.vino.nombre}: app ${e.vino.stock} bot.`));
  console.log(`filas sueltas del Excel: ${filasSueltas.length} (con cantidad vacía: ${filasSueltas.filter((f) => vacias.has(f.fila)).length})`);
  console.log(`vinos de la app sin fila en el Excel: ${vinosSueltos.length} (con stock: ${vinosSueltos.filter((v) => v.stock > 0).length})`);
})();
