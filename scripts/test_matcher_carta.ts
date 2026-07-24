// Mide cuántas de las 65 líneas "no identificadas" recupera el matcher en código
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { emparejarCarta, puntuar, type LineaCarta } from "../lib/carta";
import type { Vino } from "../lib/types";

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const UMBRAL = Number(process.argv[2] ?? 0.72);

(async () => {
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  const { data: vd } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (vd ?? []) as Vino[];

  const { data: doc } = await supabase
    .from("documentos")
    .select("resultado")
    .eq("id", 14)
    .single();
  const noEnc = (doc?.resultado?.no_encontrados ?? []) as { texto: string }[];
  const lineas: LineaCarta[] = noEnc.map((x) => ({
    texto: x.texto.replace(" — en la carta pero no en el inventario", "").trim(),
  }));

  // Los vinos ya casados por la IA no deben volver a asignarse
  const yaCasados = new Set<number>((doc?.resultado?.carta_ids ?? []) as number[]);
  const libres = vinos.filter((v) => !yaCasados.has(v.id));

  const { casados, sinCasar } = emparejarCarta(lineas, libres, UMBRAL);
  console.log(`umbral ${UMBRAL} · ${casados.length} de ${lineas.length} recuperadas\n`);
  console.log("── RECUPERADAS ──");
  casados
    .sort((a, b) => b.score - a.score)
    .forEach((c) =>
      console.log(
        `  ${c.score.toFixed(2)}  "${c.linea.texto}"  →  ID${c.vino.id} ${c.vino.bodega} | ${c.vino.nombre} (${c.vino.anio ?? "NV"})`
      )
    );
  console.log("\n── SIGUEN SIN CASAR ──");
  sinCasar.forEach((l) => {
    // mejor candidato por debajo del umbral, para calibrar
    let mejor = { s: 0, v: null as Vino | null };
    for (const v of libres) {
      const s = puntuar(l, v);
      if (s > mejor.s) mejor = { s, v };
    }
    console.log(
      `  "${l.texto}"${mejor.v ? `  (mejor: ${mejor.s.toFixed(2)} ID${mejor.v.id} ${mejor.v.bodega} | ${mejor.v.nombre})` : ""}`
    );
  });
})();
