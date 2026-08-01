// Descarga las ventas del TPV día a día y las carga como HISTÓRICO de
// análisis. No modifica el stock: solo alimenta el panel de Ventas.
//
//   npx tsx scripts/cargar_historico.ts 2026-01-01 2026-07-31 [--aplicar]
//
// Sin --aplicar hace una simulación y no escribe nada.
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const SALIDA = path.join(__dirname, "historico_carga.txt");
const buf: string[] = [];
const log = (s = "") => {
  buf.push(s);
  fs.writeFileSync(SALIDA, buf.join("\n"), "utf8");
};

for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

import { ventasDelDia, login, abrirSesion } from "../lib/hiopos";
import { casarVentas, type LineaVenta } from "../lib/ventas-tpv";
import type { Vino } from "../lib/types";

type Item = {
  vino_id: number;
  qty: number;
  fecha: string;
  precio: number | null;
  coste: number | null;
  nota: string;
};

const dias = (desde: string, hasta: string) => {
  const out: string[] = [];
  const d = new Date(desde + "T00:00:00Z");
  const f = new Date(hasta + "T00:00:00Z");
  while (d <= f) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

(async () => {
  const desde = process.argv[2] ?? "2026-01-01";
  const hasta = process.argv[3] ?? "2026-07-31";
  const aplicar = process.argv.includes("--aplicar");

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  const { data: vd } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (vd ?? []) as Vino[];
  const porId = new Map(vinos.map((v) => [v.id, v]));
  const { data: aliasRows } = await supabase.from("alias_carta").select("texto_norm, vino_id");
  const alias = new Map<string, number>(
    (aliasRows ?? []).map((a) => [a.texto_norm as string, a.vino_id as number])
  );

  const token = await login();
  await abrirSesion(token);
  log(`sesión abierta · catálogo ${vinos.length} vinos · ${aplicar ? "APLICAR" : "SIMULACIÓN"}`);

  const lista = dias(desde, hasta);
  const items: Item[] = [];
  let diasConVentas = 0;
  let sinCasarTotal = 0;
  const noCasados = new Map<string, { uds: number; eur: number }>();

  for (const dia of lista) {
    let ventas;
    try {
      ventas = await ventasDelDia(dia, { token, limite: 1000 });
    } catch (e) {
      log(`  ${dia}: error ${(e as Error).message}`);
      continue;
    }
    if (!ventas.length) continue;
    diasConVentas++;

    const lineas: LineaVenta[] = ventas.map((v) => ({
      texto: v.nombre,
      unidades: v.unidades,
      codigo: v.codigo,
      importe: v.venta,
    }));
    const r = casarVentas(lineas, vinos, alias, `TPV ${dia}`);

    for (const it of r.tpv_items ?? []) {
      const linea = lineas.find((l) => l.texto === it.texto);
      const unit =
        linea && linea.unidades > 0 && linea.importe
          ? Math.round((linea.importe / linea.unidades) * 100) / 100
          : null;
      const vino = porId.get(it.vino_id);
      items.push({
        vino_id: it.vino_id,
        qty: it.qty,
        fecha: dia,
        precio: unit ?? (vino ? Number(vino.precio) : null),
        coste: vino?.precio_compra != null ? Number(vino.precio_compra) : null,
        nota: `Histórico TPV · ${it.texto}`,
      });
    }
    for (const s of r.carta_sin_casar ?? []) {
      sinCasarTotal += s.qty ?? 0;
      const prev = noCasados.get(s.texto) ?? { uds: 0, eur: 0 };
      prev.uds += s.qty ?? 0;
      noCasados.set(s.texto, prev);
    }
    if (diasConVentas % 20 === 0) log(`  … ${dia} · ${items.length} ventas de vino acumuladas`);
  }

  const botellas = items.reduce((s, i) => s + Math.abs(i.qty), 0);
  const facturacion = items.reduce((s, i) => s + Math.abs(i.qty) * (i.precio ?? 0), 0);
  const conCoste = items.filter((i) => i.coste && i.coste > 0);
  const beneficio = conCoste.reduce(
    (s, i) => s + Math.abs(i.qty) * ((i.precio ?? 0) - (i.coste ?? 0)),
    0
  );

  log(`\n═══ RESUMEN ${desde} → ${hasta} ═══`);
  log(`  días con ventas    : ${diasConVentas} de ${lista.length}`);
  log(`  movimientos de vino: ${items.length}`);
  log(`  botellas           : ${botellas}`);
  log(`  facturación vino   : ${Math.round(facturacion).toLocaleString("es-ES")} €`);
  log(`  beneficio estimado : ${Math.round(beneficio).toLocaleString("es-ES")} € (${conCoste.length} con coste conocido)`);
  log(`  referencias tocadas: ${new Set(items.map((i) => i.vino_id)).size}`);

  if (!aplicar) {
    log(`\n(simulación: no se ha escrito nada. Añade --aplicar para cargarlo)`);
    return;
  }

  log(`\nEnviando en bloques…`);
  // Una sola llamada borraría y recargaría; se hace por lotes acumulando
  const LOTE = 400;
  let insertados = 0;
  for (let i = 0; i < items.length; i += LOTE) {
    const trozo = items.slice(i, i + LOTE);
    const { data, error } = await supabase.rpc(
      i === 0 ? "cargar_historico_ventas" : "anadir_historico_ventas",
      { p_items: trozo }
    );
    if (error) {
      log(`  error en el lote ${i}: ${error.message}`);
      return;
    }
    insertados += (data as { insertados: number }).insertados;
    log(`  lote ${i / LOTE + 1}: ${insertados} acumulados`);
  }
  log(`\n✓ ${insertados} movimientos históricos cargados. El stock NO se ha tocado.`);
})();
