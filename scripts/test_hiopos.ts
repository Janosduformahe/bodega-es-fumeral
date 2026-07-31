// Prueba la API interna de HioPOS Analytics con el token capturado
import fs from "fs";
import path from "path";

const SALIDA = path.join(__dirname, "hiopos_resultado.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

// Cargar .env.local en process.env
for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

import { ventasDelDia, cuerpoDebug } from "../lib/hiopos";

(async () => {
  const fecha = process.argv[2] ?? "2026-07-31";
  log(`Consultando ventas del ${fecha}…`);

  // Volcado crudo para ver la forma real de la respuesta
  const resp = await fetch(process.env.HIOPOS_URL!, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "x-auth-token": process.env.HIOPOS_TOKEN!,
      origin: "https://cloudclient67.hiopos.com",
      referer: "https://cloudclient67.hiopos.com/icgfront/analytics",
    },
    body: JSON.stringify(cuerpoDebug(fecha, 20)),
  });
  log(`HTTP ${resp.status}`);
  const crudo = await resp.text();
  fs.writeFileSync(path.join(__dirname, "hiopos_crudo.json"), crudo, "utf8");
  try {
    const j = JSON.parse(crudo);
    log(`claves: ${Object.keys(j).join(", ")}`);
    log(`empty: ${j.empty} · rows: ${(j.rows ?? []).length}`);
    log(`headers (${(j.headers ?? []).length}):`);
    (j.headers ?? []).forEach((h: Record<string, unknown>, i: number) => {
      if (h) log(`   [${i}] ${h.name} · attributeId:${h.attributeId ?? "-"} metricId:${h.metricId ?? "-"} pos:${h.position}`);
    });
    log(`primeras filas:`);
    (j.rows ?? []).slice(0, 5).forEach((r: unknown[]) => log("   " + JSON.stringify(r)));
    if (j.totalsRow) log(`totalsRow: ${JSON.stringify(j.totalsRow)}`);
    if (j.errorMessage || j.message) log(`mensaje: ${j.errorMessage ?? j.message}`);
  } catch {
    log("respuesta no JSON: " + crudo.slice(0, 400));
  }

  log("\n── vía cliente ──");
  try {
    const ventas = await ventasDelDia(fecha);
    log(`✓ ${ventas.length} artículos con ventas\n`);
    log("cod    uds   venta      docs  artículo");
    log("─".repeat(60));
    ventas
      .sort((a, b) => b.venta - a.venta)
      .slice(0, 30)
      .forEach((v) =>
        log(
          `${String(v.codigo).padStart(5)} ${String(v.unidades).padStart(5)} ${v.venta
            .toFixed(2)
            .padStart(9)} € ${String(v.documentos).padStart(4)}  ${v.nombre}`
        )
      );
    const totalUds = ventas.reduce((s, v) => s + v.unidades, 0);
    const totalVenta = ventas.reduce((s, v) => s + v.venta, 0);
    log(`\nTOTAL: ${totalUds} unidades · ${totalVenta.toFixed(2)} €`);
  } catch (e) {
    log("FALLO: " + (e instanceof Error ? e.message : String(e)));
  }
})();
