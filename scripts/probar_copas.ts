// Prueba el casado con copas contra las ventas reales de un día. NO escribe.
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).replace(/^\uFEFF/, "").trim()] = l.slice(i + 1).trim();
}
import { ventasDelDia, login, abrirSesion } from "../lib/hiopos";
import { casarVentas, type LineaVenta } from "../lib/ventas-tpv";
import type { Vino } from "../lib/types";
(async () => {
  const token = await login();
  await abrirSesion(token);
  const dia = process.argv[2] ?? "2026-08-03";
  const ventas = await ventasDelDia(dia, { token, limite: 1000 });
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  await supabase.auth.signInWithPassword({ email: "equipo@esfumeral.com", password: "EsFumeral2026!" });
  const { data } = await supabase.from("vinos").select("*").eq("activo", true);
  const { data: aliasRows } = await supabase.from("alias_carta").select("texto_norm, vino_id");
  const alias = new Map<string, number>((aliasRows ?? []).map((a) => [a.texto_norm as string, a.vino_id as number]));
  const lineas: LineaVenta[] = ventas.map((v) => ({ texto: v.nombre, unidades: v.unidades, codigo: v.codigo, importe: v.venta }));
  const r = casarVentas(lineas, (data ?? []) as Vino[], alias, `prueba ${dia}`);
  console.log(`── ${dia}: ${ventas.length} artículos ──`);
  console.log("descuentos (tpv_items):", r.tpv_items!.length, "| botellas:", r.tpv_items!.reduce((s, i) => s + Math.abs(i.qty), 0));
  for (const i of r.tpv_items!.filter((x) => /copas/.test(x.texto))) console.log("  COPA →", i.texto, "| qty", i.qty);
  console.log("\navisos de copa:");
  r.no_encontrados!.filter((x) => /copa/i.test(x.texto)).forEach((x) => console.log("  ", x.texto));
})();
