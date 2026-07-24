// Test end-to-end del flujo Excel con el archivo real del usuario:
// login → catálogo desde Supabase → CSV de la hoja más grande → OpenRouter → parse
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

const RUTA_XLSX =
  "C:/Users/junto/Desktop/BRUXI MAXXX/downloadbyjanos/Copia de INVENTARIO BUENO bueno buenisimo (1).xlsx";

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

function promptExcel(csv, vinos) {
  const catalogo = vinos
    .map(
      (w) =>
        `ID:${w.id}|${w.anio ?? "NV"}|${w.bodega}|${w.nombre}|stock:${w.stock}|precio:${w.precio}`
    )
    .join("\n");
  return `Eres un asistente de gestión de bodega de restaurante. Te adjunto el contenido (en CSV) del Excel de inventario actualizado.

El archivo tiene estas columnas aproximadas: Año, Bodega, Nombre, Talla, Proveedor, Inventario Final, Valor Final, Compra, Compra+IVA, Precio Venta, y columnas de stock con fechas (la última columna de stock es la más reciente — úsala como stock actual).

Tu tarea: comparar cada fila del Excel con el catálogo actual de la bodega y devolver SOLO un JSON con este formato exacto (sin markdown, sin texto adicional):

{
  "actualizaciones": [
    {"id": 5, "stock_nuevo": 12, "precio_nuevo": 130}
  ],
  "nuevas_referencias": [
    {"anio": 2023, "bodega": "Nombre bodega", "nombre": "Nombre vino", "tipo": "Tinto", "pais": "España", "uva": "Tempranillo", "precio": 85, "stock": 6}
  ],
  "no_identificados": [
    {"texto": "descripción del vino que no se pudo identificar"}
  ]
}

REGLAS:
- El catálogo de abajo ya incluye el stock y el precio ACTUALES de cada vino. En "actualizaciones" incluye SOLO los vinos cuyo stock o precio CAMBIAN respecto al catálogo — omite por completo los que quedan igual.
- Para "actualizaciones": busca coincidencia aproximada entre filas del Excel y el catálogo (puede haber variaciones ortográficas). Usa el ID del catálogo.
- IMPORTANTE: el stock actual es el de la columna "01/06/26" EXACTAMENTE (es la columna de fecha más reciente del archivo). IGNORA cualquier otra columna de fecha y la columna "INVENTARIO FINAL".
- Para "precio_nuevo": usa la columna "Precio Venta" si está disponible; si el precio no cambia, omite el campo.
- Para "nuevas_referencias": incluye solo vinos que NO existan en el catálogo actual. "anio" es un número o null.
- Ignora filas de agrupación/sección del Excel (nombres de país o tipo sueltos con contadores) — no son vinos.
- "tipo" debe ser uno de: Espumoso, Blanco, Rosado, Tinto, Dulce.
- Devuelve SOLO el JSON válido, COMPACTO EN UNA SOLA LÍNEA (sin saltos de línea ni espacios de indentación), sin texto extra.

CATÁLOGO ACTUAL:
${catalogo}

CONTENIDO DEL EXCEL (CSV):
${csv}`;
}

(async () => {
  const supabase = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  const { error: loginErr } = await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  if (loginErr) throw new Error("login: " + loginErr.message);

  const { data: vinos, error } = await supabase
    .from("vinos")
    .select("*")
    .eq("activo", true)
    .order("id");
  if (error) throw new Error(error.message);
  console.log(`catálogo: ${vinos.length} vinos`);

  const wb = XLSX.readFile(RUTA_XLSX);
  const csvs = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]));
  let csv = csvs.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (csv.length > 200000) csv = csv.slice(0, 200000) + "\n...(truncado)";
  console.log(`CSV elegido: ${csv.length} chars`);

  const t0 = Date.now();
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL_OVERRIDE || env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
      max_tokens: 60000,
      reasoning: { effort: "low" },
      messages: [{ role: "user", content: [{ type: "text", text: promptExcel(csv, vinos) }] }],
    }),
  });
  if (!resp.ok) throw new Error("openrouter " + resp.status + ": " + (await resp.text()).slice(0, 500));
  const data = await resp.json();
  console.log(`respuesta en ${Math.round((Date.now() - t0) / 1000)}s · modelo: ${data.model} · finish: ${data.choices?.[0]?.finish_reason} · tokens out: ${data.usage?.completion_tokens}`);

  let raw = (data.choices?.[0]?.message?.content || "").trim()
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  fs.writeFileSync(path.join(__dirname, "raw_ia.txt"), raw, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    if (m) {
      const p = Number(m[1]);
      console.log("── contexto del error de parseo ──");
      console.log(JSON.stringify(raw.slice(Math.max(0, p - 200), p + 200)));
    }
    const { jsonrepair } = require("jsonrepair");
    const ini = raw.indexOf("{");
    const fin = raw.lastIndexOf("}");
    parsed = JSON.parse(jsonrepair(raw.slice(ini, fin + 1)));
    console.log("(parseado con jsonrepair)");
  }
  console.log(`✓ JSON OK: ${parsed.actualizaciones?.length ?? 0} actualizaciones · ${parsed.nuevas_referencias?.length ?? 0} nuevas · ${parsed.no_identificados?.length ?? 0} no identificados`);
  const conCambio = (parsed.actualizaciones ?? []).filter((u) => {
    const v = vinos.find((x) => x.id === u.id);
    return v && (Number(u.stock_nuevo) !== v.stock || (Number(u.precio_nuevo) > 0 && Number(u.precio_nuevo) !== Number(v.precio)));
  });
  console.log(`   de las cuales con cambio real de stock/precio: ${conCambio.length}`);
  console.log("   muestra:", JSON.stringify((parsed.actualizaciones ?? []).slice(0, 3)));
  console.log("   nuevas muestra:", JSON.stringify((parsed.nuevas_referencias ?? []).slice(0, 2)));
})().catch((e) => {
  console.error("FALLO:", e.message);
  process.exit(1);
});
