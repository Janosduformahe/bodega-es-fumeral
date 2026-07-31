// Evalúa el matcher de carta contra la verdad de referencia (65 líneas)
// y barre umbrales para elegir los tramos automático / sugerencia / manual.
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { puntuar, type LineaCarta } from "../lib/carta";
import type { Vino } from "../lib/types";

// Los logs van a fichero: la consola de PowerShell se atraganta con la salida
const SALIDA = path.join(__dirname, "eval_resultado.txt");
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

const VERDAD =
  "C:/Users/junto/AppData/Local/Temp/claude/c--Users-junto-Desktop-BRUXI-MAXXX/382ec96d-8602-4c7f-a44b-4dfc1a716ab1/scratchpad/verdad_carta.json";

type Verdad = { n: number; texto: string; vino_id: number | null; confianza: string };

(async () => {
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  const { data: vd } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (vd ?? []) as Vino[];
  const porId = new Map(vinos.map((v) => [v.id, v]));
  const verdad: Verdad[] = JSON.parse(
    fs.readFileSync(VERDAD, "utf8").replace(/^﻿/, "")
  );

  // La verdad de referencia se hizo con el catálogo de antes: si el vino
  // objetivo ya se dio de baja, esa línea deja de ser comparable
  const bajas = verdad.filter((t) => t.vino_id !== null && !porId.has(t.vino_id));
  if (bajas.length) {
    log(`⚠ ${bajas.length} líneas de la verdad apuntan a vinos ya dados de baja: se excluyen`);
  }
  const vigente = verdad.filter((t) => t.vino_id === null || porId.has(t.vino_id));

  // Mejor candidato del catálogo COMPLETO para cada línea
  const evaluado = vigente.map((t) => {
    const linea: LineaCarta = { texto: t.texto };
    let mejor = { score: 0, vino: null as Vino | null };
    for (const v of vinos) {
      const s = puntuar(linea, v);
      if (s > mejor.score) mejor = { score: s, vino: v };
    }
    return { ...t, mejor };
  });

  log("── BARRIDO DE UMBRALES (catálogo completo, 65 líneas) ──");
  log("umbral | aciertos | falsos+ | perdidas | precisión");
  for (const u of [0.6, 0.67, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]) {
    let ok = 0,
      fp = 0,
      perdidas = 0;
    for (const e of evaluado) {
      const propone = e.mejor.score >= u ? e.mejor.vino!.id : null;
      if (propone === null) {
        if (e.vino_id !== null) perdidas++;
      } else if (propone === e.vino_id) ok++;
      else fp++;
    }
    const prec = ok + fp > 0 ? ((ok / (ok + fp)) * 100).toFixed(0) : "—";
    log(
      `${u.toFixed(2).padStart(6)} | ${String(ok).padStart(8)} | ${String(fp).padStart(7)} | ${String(perdidas).padStart(8)} | ${prec}%`
    );
  }

  log("\n── FALSOS POSITIVOS con umbral 0.90 ──");
  for (const e of evaluado) {
    if (e.mejor.score >= 0.9 && e.mejor.vino!.id !== e.vino_id) {
      const esperado = e.vino_id ? porId.get(e.vino_id) : null;
      log(
        `  "${e.texto}"\n    propone ${e.mejor.score.toFixed(2)} ID${e.mejor.vino!.id} ${e.mejor.vino!.bodega} | ${e.mejor.vino!.nombre}` +
          `\n    verdad: ${esperado ? `ID${esperado.id} ${esperado.bodega} | ${esperado.nombre}` : "NO está en el catálogo"}`
      );
    }
  }

  log("\n── ACIERTOS QUE CAEN EN LA BANDA DE SUGERENCIA (0.60–0.90) ──");
  let banda = 0;
  for (const e of evaluado) {
    if (e.mejor.score >= 0.6 && e.mejor.score < 0.9 && e.mejor.vino!.id === e.vino_id) {
      banda++;
      log(`  ${e.mejor.score.toFixed(2)} "${e.texto}" → ID${e.vino_id}`);
    }
  }
  log(`  (${banda} aciertos recuperables con confirmación de un toque)`);

  const nunca = evaluado.filter((e) => e.vino_id !== null && e.mejor.score < 0.6);
  log(`\n── ${nunca.length} ACIERTOS QUE NI SIQUIERA LLEGAN A 0.60 (irían a búsqueda manual) ──`);
  nunca.forEach((e) => {
    const v = porId.get(e.vino_id!);
    log(
      `  ${e.mejor.score.toFixed(2)} "${e.texto}" → deberia ser ID${e.vino_id} ${v?.bodega} | ${v?.nombre}`
    );
  });
})();
