// Simula un export "Por artículos" de HioPOS Analytics y comprueba el
// parseo + casado contra el catálogo real.
import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { emparejarCarta } from "../lib/carta";
import { parsearVentasTpv } from "../lib/tpv";
import type { Vino } from "../lib/types";

const SALIDA = path.join(__dirname, "tpv_resultado.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

// Estructura del informe tal como aparece en HioPOS Analytics
const FILAS = [
  ["Board - Restaurante", "", "", "", "", ""],
  ["30/07/2026", "", "", "", "", ""],
  [],
  ["Artículo", "Subartículo", "Uds.V", "Uds.V %ST", "Venta", "Venta %ST"],
  ["APERITIVO", "", 146, "14,44%", "639,00 €", "3,75%"],
  ["AGUA", "", 66, "6,53%", "448,00 €", "2,63%"],
  ["COCA COLA ZERO", "", 28, "2,77%", "137,50 €", "0,81%"],
  ["Zarate", "", 3, "0,30%", "150,00 €", "0,88%"],
  ["Ossian Viñas Viejas", "", 2, "0,20%", "150,00 €", "0,88%"],
  ["Oxer Wines Suzzane", "", 1, "0,10%", "95,00 €", "0,56%"],
  ["Levante 32", "", 4, "0,40%", "280,00 €", "1,64%"],
  ["Do Ferreiro Albariño", "", 2, "0,20%", "100,00 €", "0,59%"],
  ["Recaredo Terrers", "", 1, "0,10%", "55,00 €", "0,32%"],
  ["Chateau Saint Maur Excellence", "", 3, "0,30%", "270,00 €", "1,58%"],
  ["TOTAL", "", 256, "100%", "17.036,00 €", "100%"],
];

(async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(FILAS), "Por artículos");
  const buffer = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  const informe = parsearVentasTpv(buffer, false);
  if (!informe) {
    log("FALLO: no se reconoció el informe");
    return;
  }
  log(`parseo OK · hoja "${informe.hoja}" · ${informe.ventas.length} artículos con ventas`);
  informe.ventas.forEach((v) => log(`   ${v.unidades} × ${v.texto} (${v.importe} €)`));

  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  const { data } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (data ?? []) as Vino[];

  const { casados, sinCasar } = emparejarCarta(
    informe.ventas.map((v) => ({ texto: v.texto })),
    vinos,
    0.55
  );
  const auto = casados.filter((c) => c.score >= 0.8);
  const sug = casados.filter((c) => c.score < 0.8);

  log(`\n══ CASADO ══`);
  log(`  automáticos: ${auto.length} · sugerencias: ${sug.length} · sin casar: ${sinCasar.length}`);
  log(`\n── AUTOMÁTICOS (se descuentan solos) ──`);
  auto.forEach((c) => {
    const u = informe.ventas.find((v) => v.texto === c.linea.texto)!.unidades;
    log(`  ${c.score.toFixed(2)} −${u} "${c.linea.texto}" → ${c.vino.bodega} | ${c.vino.nombre} (stock ${c.vino.stock})`);
  });
  log(`\n── SUGERENCIAS (confirmar) ──`);
  sug.forEach((c) => log(`  ${c.score.toFixed(2)} "${c.linea.texto}" ≈ ${c.vino.bodega} | ${c.vino.nombre}`));
  log(`\n── SIN CASAR (comida/bebida o nombres nuevos) ──`);
  sinCasar.forEach((l) => log(`  "${l.texto}"`));
})();
