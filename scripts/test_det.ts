// Prueba local de la vía determinista con el Excel real y la BD real
import fs from "fs";
import path from "path";
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

(async () => {
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  const { data } = await supabase.from("vinos").select("*").eq("activo", true).order("id");
  const vinos = (data ?? []) as Vino[];
  const dbTotal = vinos.reduce((s, v) => s + v.stock, 0);
  console.log(`BD: ${vinos.length} vinos, ${dbTotal} botellas`);

  const buffer = fs.readFileSync(
    "C:/Users/junto/Desktop/BRUXI MAXXX/downloadbyjanos/Copia de INVENTARIO BUENO bueno buenisimo (1).xlsx"
  );
  const inv = parsearInventario(buffer);
  if (!inv) throw new Error("no se pudo parsear");
  const excelTotal = inv.filas.reduce((s, f) => s + f.stock, 0);
  console.log(`Excel: ${inv.filas.length} filas de vino, ${excelTotal} botellas (columna ${inv.etiquetaFecha})`);

  const { emparejados, filasSueltas, vinosSueltos } = emparejar(inv.filas, vinos);
  console.log(`\nMatching determinista: ${emparejados.length} parejas · ${filasSueltas.length} filas sueltas · ${vinosSueltos.length} vinos de BD sin fila`);

  let movs = 0, deltaTotal = 0, precios = 0;
  for (const { fila, vino } of emparejados) {
    const d = fila.stock - vino.stock;
    if (d !== 0) { movs++; deltaTotal += d; }
    const pv = Math.round(fila.precioVenta ?? 0);
    if (pv > 0 && pv !== Math.round(Number(vino.precio))) precios++;
  }
  const stockSueltas = filasSueltas.reduce((s, f) => s + f.stock, 0);
  const stockVinosSueltos = vinosSueltos.reduce((s, v) => s + v.stock, 0);
  console.log(`Diff sobre parejas: ${movs} cambios de stock (delta neto ${deltaTotal >= 0 ? "+" : ""}${deltaTotal}) · ${precios} cambios de precio`);
  console.log(`Filas sueltas del Excel suman ${stockSueltas} botellas (irían a IA de emparejado/nuevas)`);
  console.log(`Vinos de BD sin fila suman ${stockVinosSueltos} botellas (se quedarían igual)`);
  console.log(`\nProyección si todas las sueltas fueran nuevas: BD ${dbTotal} + ${deltaTotal} + ${stockSueltas} = ${dbTotal + deltaTotal + stockSueltas} (objetivo Excel: ${excelTotal} + ${stockVinosSueltos} fuera de Excel)`);

  console.log("\n── muestra de filas sueltas ──");
  filasSueltas.slice(0, 12).forEach((f) => console.log(`  F${f.fila}: ${f.anio ?? "NV"} | ${f.bodega} | ${f.nombre}${f.talla ? " | " + f.talla : ""} | stock ${f.stock}`));
  console.log("── muestra de vinos BD sin fila ──");
  vinosSueltos.slice(0, 12).forEach((v) => console.log(`  ID${v.id}: ${v.anio ?? "NV"} | ${v.bodega} | ${v.nombre} | stock ${v.stock}`));
})();
