// Flujo nuevo completo con la carta REAL: extracción por IA + casado en código
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { emparejarCarta, promptExtraerCarta, type LineaCarta } from "../lib/carta";
import type { Vino } from "../lib/types";

const SALIDA = path.join(__dirname, "carta_resultado.txt");
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

const PDF =
  "C:/Users/junto/AppData/Local/Temp/claude/c--Users-junto-Desktop-BRUXI-MAXXX/382ec96d-8602-4c7f-a44b-4dfc1a716ab1/scratchpad/CARTA_SALA.pdf";
const UMBRAL_AUTO = 0.8;
const UMBRAL_SUG = 0.55;

(async () => {
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  const { data: vd } = await supabase.from("vinos").select("*").eq("activo", true);
  const vinos = (vd ?? []) as Vino[];

  const b64 = fs.readFileSync(PDF).toString("base64");
  const t0 = Date.now();
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3.5-flash",
      max_tokens: 60000,
      reasoning: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: { filename: "carta.pdf", file_data: `data:application/pdf;base64,${b64}` },
            },
            { type: "text", text: promptExtraerCarta() },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`openrouter ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const raw = (data.choices?.[0]?.message?.content ?? "")
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/, "");
  const ini = raw.indexOf("{");
  const fin = raw.lastIndexOf("}");
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(ini, fin + 1));
  } catch {
    const { jsonrepair } = require("jsonrepair");
    parsed = JSON.parse(jsonrepair(raw.slice(ini, fin + 1)));
  }

  const lineas: LineaCarta[] = (parsed.lineas ?? []).map((l: Record<string, unknown>) => ({
    texto: String(l.texto ?? "").trim(),
    bodega: l.bodega ? String(l.bodega) : null,
    nombre: l.nombre ? String(l.nombre) : null,
    anio: Number(l.anio) || null,
    precio: Number(l.precio) || null,
  }));

  log(`extracción: ${lineas.length} líneas en ${Math.round((Date.now() - t0) / 1000)}s (${data.usage?.completion_tokens} tokens)`);

  const { casados, sinCasar } = emparejarCarta(lineas, vinos, UMBRAL_SUG);
  const auto = casados.filter((c) => c.score >= UMBRAL_AUTO);
  const sug = casados.filter((c) => c.score < UMBRAL_AUTO);

  log(`\n══ RESULTADO ══`);
  log(`  automáticas : ${auto.length}`);
  log(`  sugerencias : ${sug.length} (confirmar de un toque)`);
  log(`  sin casar   : ${sinCasar.length} (buscar a mano)`);
  log(`  quedarían fuera de carta: ${vinos.length - auto.length}`);

  log(`\n── SUGERENCIAS ──`);
  sug
    .sort((a, b) => b.score - a.score)
    .forEach((c) =>
      log(`  ${c.score.toFixed(2)} "${c.linea.texto}"  ≈  ${c.vino.bodega} | ${c.vino.nombre} (${c.vino.anio ?? "NV"})`)
    );

  log(`\n── SIN CASAR ──`);
  sinCasar.forEach((l) => log(`  "${l.texto}"${l.precio ? ` · ${l.precio}€` : ""}`));

  log(`\n── MUESTRA DE AUTOMÁTICAS (20) ──`);
  auto.slice(0, 20).forEach((c) =>
    log(`  ${c.score.toFixed(2)} "${c.linea.texto}" → ${c.vino.bodega} | ${c.vino.nombre}`)
  );
})();
