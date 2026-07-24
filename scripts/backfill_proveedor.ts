// Genera el SQL para rellenar `proveedor` en los vinos ya existentes,
// usando el mismo matching determinista de la importación.
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

const RUTA =
  "C:/Users/junto/Desktop/BRUXI MAXXX/downloadbyjanos/Copia de INVENTARIO BUENO bueno buenisimo (1).xlsx";

(async () => {
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  const { data } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (data ?? []) as Vino[];

  const inv = parsearInventario(fs.readFileSync(RUTA));
  if (!inv) throw new Error("no parseable");
  const { emparejados } = emparejar(inv.filas, vinos);

  const porProv = new Map<string, number[]>();
  let sinProv = 0;
  for (const { fila, vino } of emparejados) {
    if (!fila.proveedor) {
      sinProv++;
      continue;
    }
    const p = fila.proveedor.trim();
    if (!porProv.has(p)) porProv.set(p, []);
    porProv.get(p)!.push(vino.id);
  }

  const lineas: string[] = [];
  for (const [prov, ids] of [...porProv.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lineas.push(
      `update vinos set proveedor = '${prov.replace(/'/g, "''")}' where id in (${ids.join(",")});`
    );
  }
  fs.writeFileSync(path.join(__dirname, "backfill_proveedor.sql"), lineas.join("\n"), "utf8");

  console.log(`emparejados: ${emparejados.length} · con proveedor: ${emparejados.length - sinProv}`);
  console.log(`proveedores distintos: ${porProv.size}`);
  [...porProv.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 12)
    .forEach(([p, ids]) => console.log(`  ${p}: ${ids.length} referencias`));
  console.log(`\nSQL escrito en scripts/backfill_proveedor.sql (${lineas.length} sentencias)`);
})();
