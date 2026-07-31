// Descarga las ventas de todo el año del TPV y analiza cuántas casan con
// el catálogo. NO toca la base de datos: es solo diagnóstico.
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const SALIDA = path.join(__dirname, "analisis_anual.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

import { ventasDelDia, login, abrirSesion } from "../lib/hiopos";
import { emparejarCarta } from "../lib/carta";
import { ES_COPA } from "../lib/ventas-tpv";
import type { Vino } from "../lib/types";

(async () => {
  // Una sola sesión para todas las consultas
  const token = await login();
  await abrirSesion(token);
  log("sesión abierta\n");

  const desde = process.argv[2] ?? "2026-01-01";
  const hasta = process.argv[3] ?? "2026-07-31";

  const ventas = await ventasDelDia(desde, { token, hasta, limite: 3000 });
  log(`═══ VENTAS ${desde} → ${hasta} ═══`);
  log(`${ventas.length} artículos distintos vendidos`);
  const totalUds = ventas.reduce((s, v) => s + v.unidades, 0);
  const totalEur = ventas.reduce((s, v) => s + v.venta, 0);
  log(`${totalUds.toLocaleString("es-ES")} unidades · ${Math.round(totalEur).toLocaleString("es-ES")} €\n`);

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
  log(`catálogo: ${vinos.length} referencias activas\n`);

  const copas = ventas.filter((v) => ES_COPA.test(v.nombre));
  const resto = ventas.filter((v) => !ES_COPA.test(v.nombre));

  const { casados, sinCasar } = emparejarCarta(
    resto.map((v) => ({ texto: v.nombre })),
    vinos,
    0.55,
    true
  );
  const auto = casados.filter((c) => c.score >= 0.8);
  const sug = casados.filter((c) => c.score < 0.8);
  const uds = (t: string) => ventas.find((v) => v.nombre === t)?.unidades ?? 0;
  const eur = (t: string) => ventas.find((v) => v.nombre === t)?.venta ?? 0;

  const udsAuto = auto.reduce((s, c) => s + uds(c.linea.texto), 0);
  const eurAuto = auto.reduce((s, c) => s + eur(c.linea.texto), 0);
  const udsSug = sug.reduce((s, c) => s + uds(c.linea.texto), 0);
  const udsCopa = copas.reduce((s, c) => s + c.unidades, 0);

  log("═══ CASADO ═══");
  log(`  automáticos : ${auto.length} referencias · ${udsAuto} botellas · ${Math.round(eurAuto).toLocaleString("es-ES")} €`);
  log(`  sugerencias : ${sug.length} referencias · ${udsSug} botellas`);
  log(`  sin casar   : ${sinCasar.length} artículos`);
  log(`  por copas   : ${copas.length} referencias · ${udsCopa} copas\n`);

  log("── TOP 25 VINOS CASADOS (por facturación) ──");
  [...auto]
    .sort((a, b) => eur(b.linea.texto) - eur(a.linea.texto))
    .slice(0, 25)
    .forEach((c) =>
      log(
        `  ${String(uds(c.linea.texto)).padStart(4)} bot · ${String(Math.round(eur(c.linea.texto))).padStart(6)} € · ${c.score.toFixed(2)} · "${c.linea.texto}"\n         → ${c.vino.bodega} | ${c.vino.nombre}`
      )
    );

  log("\n── SUGERENCIAS (revisar) ──");
  sug
    .sort((a, b) => eur(b.linea.texto) - eur(a.linea.texto))
    .forEach((c) =>
      log(`  ${c.score.toFixed(2)} ${uds(c.linea.texto)} bot "${c.linea.texto}"\n         ≈ ${c.vino.bodega} | ${c.vino.nombre}`)
    );

  log("\n── SIN CASAR con facturación alta (posibles vinos) ──");
  sinCasar
    .map((l) => ({ t: l.texto, u: uds(l.texto), e: eur(l.texto) }))
    .filter((x) => x.e >= 150)
    .sort((a, b) => b.e - a.e)
    .slice(0, 60)
    .forEach((x) => log(`  ${String(x.u).padStart(4)} × ${String(Math.round(x.e)).padStart(6)} €  "${x.t}"`));

  log("\n── VENTAS POR COPA ──");
  copas
    .sort((a, b) => b.venta - a.venta)
    .forEach((c) => log(`  ${c.unidades} × "${c.nombre}" (${Math.round(c.venta)} €)`));

  // Fichero aparte con todos los artículos, para revisar con calma
  fs.writeFileSync(
    path.join(__dirname, "tpv_articulos.csv"),
    "codigo;articulo;unidades;venta\n" +
      ventas
        .sort((a, b) => b.venta - a.venta)
        .map((v) => `${v.codigo};"${v.nombre}";${v.unidades};${v.venta}`)
        .join("\n"),
    "utf8"
  );
  log("\n(listado completo en scripts/tpv_articulos.csv)");
})();
