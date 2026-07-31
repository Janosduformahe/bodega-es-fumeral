// Casa las ventas reales del TPV con el catálogo de la bodega
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const SALIDA = path.join(__dirname, "hiopos_match.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

import { ventasDelDia } from "../lib/hiopos";
import { emparejarCarta } from "../lib/carta";
import type { Vino } from "../lib/types";

const ES_COPA = /\bcopa\b|\bcopas\b|\bby the glass\b/i;

(async () => {
  const fecha = process.argv[2] ?? "2026-07-31";
  const ventas = await ventasDelDia(fecha);
  log(`TPV ${fecha}: ${ventas.length} artículos vendidos\n`);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  const { data } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (data ?? []) as Vino[];

  const copas = ventas.filter((v) => ES_COPA.test(v.nombre));
  const botellas = ventas.filter((v) => !ES_COPA.test(v.nombre));

  const { casados, sinCasar } = emparejarCarta(
    botellas.map((v) => ({ texto: v.nombre })),
    vinos,
    0.55,
    true // modo estricto: el informe del TPV está lleno de comida
  );
  const auto = casados.filter((c) => c.score >= 0.8);
  const sug = casados.filter((c) => c.score < 0.8);

  log(`══ RESULTADO ══`);
  log(`  automáticos : ${auto.length}`);
  log(`  sugerencias : ${sug.length}`);
  log(`  sin casar   : ${sinCasar.length} (mayoría comida)`);
  log(`  ventas por copa detectadas: ${copas.length}`);

  const uds = (n: string) => ventas.find((v) => v.nombre === n)?.unidades ?? 0;

  log(`\n── VINOS QUE SE DESCONTARÍAN SOLOS ──`);
  auto.forEach((c) =>
    log(
      `  ${c.score.toFixed(2)} −${uds(c.linea.texto)}  "${c.linea.texto}"\n        → ${c.vino.bodega} | ${c.vino.nombre} (${c.vino.anio ?? "NV"}) · stock ${c.vino.stock}`
    )
  );

  log(`\n── SUGERENCIAS (confirmar de un toque) ──`);
  sug.forEach((c) =>
    log(`  ${c.score.toFixed(2)} −${uds(c.linea.texto)} "${c.linea.texto}"\n        ≈ ${c.vino.bodega} | ${c.vino.nombre}`)
  );

  log(`\n── VENTA POR COPAS (no descuenta botella entera) ──`);
  copas.forEach((c) => log(`  ${c.unidades} × "${c.nombre}" (${c.venta} €)`));

  log(`\n── SIN CASAR (primeras 25) ──`);
  sinCasar.slice(0, 25).forEach((l) => log(`  ${uds(l.texto)} × "${l.texto}"`));
})();
