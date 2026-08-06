import { NextResponse, type NextRequest } from "next/server";
import { jsonrepair } from "jsonrepair";
import * as XLSX from "xlsx";
import {
  emparejarCarta,
  mismaReferenciaOtraAnada,
  promptExtraerCarta,
} from "@/lib/carta";
import { emparejar, parsearInventario, posibleDuplicado, type FilaExcel } from "@/lib/excel";
import { parsearVentasTpv, type VentaTpv } from "@/lib/tpv";
import { createClient } from "@/lib/supabase/server";
import { promptAlbaranCierre, promptExcel } from "@/lib/prompts";
import type { ResultadoDocumento, TipoVino, Vino } from "@/lib/types";

export const maxDuration = 120; // la lectura IA de un PDF puede tardar

const TIPOS_VINO: TipoVino[] = ["Espumoso", "Blanco", "Rosado", "Tinto", "Dulce"];

// Calibrados contra la carta real del restaurante (65 líneas de referencia):
// ≥0.80 acierta el 94% (los 2 fallos son duplicados del propio catálogo);
// entre 0.55 y 0.80 se pide confirmación de un toque.
const UMBRAL_AUTO = 0.8;
const UMBRAL_SUGERENCIA = 0.55;

/** Cliente de Supabase con la sesión del usuario (solo lo que se usa aquí) */
type SupabaseLike = Awaited<ReturnType<typeof createClient>>;

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

async function llamarOpenRouter(
  parts: ContentPart[],
  maxTokens: number,
  modelo: string
): Promise<{ texto: string; modelo: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Falta OPENROUTER_API_KEY en las variables de entorno");
  }

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://bodega-es-fumeral.vercel.app",
      "X-Title": "Mi Bodega - Es Fumeral",
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      // Los modelos razonadores (Gemini 3.x) gastan salida "pensando":
      // esfuerzo bajo = rápido y suficiente para esta tarea.
      // Los modelos sin razonamiento ignoran este parámetro.
      reasoning: { effort: "low" },
      messages: [{ role: "user", content: parts }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => null);
    throw new Error(err?.error?.message || `Error de OpenRouter (${resp.status})`);
  }

  const data = await resp.json();
  const texto: string | undefined = data.choices?.[0]?.message?.content;
  if (!texto) throw new Error("OpenRouter devolvió una respuesta vacía");
  return { texto, modelo: data.model || modelo };
}

const normalizar = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (s: string) =>
  new Set(normalizar(s).split(" ").filter((t) => t.length > 2));

/** ¿La "referencia nueva" propuesta por la IA ya existe en el catálogo?
 *  Protección determinista contra duplicados por variaciones de nombre. */
function esDuplicado(
  ref: { bodega: string; nombre: string; anio: number | null },
  vinos: Vino[]
): Vino | null {
  const bRef = normalizar(ref.bodega);
  const tRef = tokens(`${ref.bodega} ${ref.nombre}`);
  for (const v of vinos) {
    // Añadas distintas = referencias distintas: nunca es duplicado
    if (ref.anio !== null && v.anio !== null && ref.anio !== v.anio) continue;
    const bCat = normalizar(v.bodega);
    if (!(bCat === bRef || bCat.includes(bRef) || bRef.includes(bCat))) continue;
    const tCat = tokens(`${v.bodega} ${v.nombre}`);
    let comunes = 0;
    for (const t of tRef) if (tCat.has(t)) comunes++;
    const solape = comunes / Math.max(1, Math.min(tRef.size, tCat.size));
    if (solape >= 0.6 || (ref.anio !== null && ref.anio === v.anio && solape >= 0.4)) {
      return v;
    }
  }
  return null;
}

// Altas nuevas propuestas por la IA (Excel o albarán con vinos fuera de catálogo)
function recogerNuevasReferencias(
  parsed: Record<string, unknown>,
  resultado: ResultadoDocumento,
  vinos: Vino[],
  multiplicadorPrecio: number
) {
  const nuevas = (parsed.nuevas_referencias ?? []) as Record<string, unknown>[];
  for (const n of nuevas) {
    const tipoVino = TIPOS_VINO.includes(n.tipo as TipoVino)
      ? (n.tipo as TipoVino)
      : "Tinto";
    const ref = {
      anio: Number(n.anio) || null,
      bodega: String(n.bodega || "").trim(),
      nombre: String(n.nombre || "").trim(),
      tipo: tipoVino,
      pais: String(n.pais || "España").trim(),
      uva: n.uva ? String(n.uva) : null,
      precio: Number(n.precio) || 0,
      stock: Math.max(0, Math.round(Number(n.stock) || 0)),
    };
    if (!ref.bodega || !ref.nombre) continue;
    const dup = esDuplicado(ref, vinos);
    if (dup) {
      resultado.no_encontrados!.push({
        texto: `"${ref.bodega} — ${ref.nombre}" parece ser "${dup.bodega} — ${dup.nombre}" (ya en catálogo) — no se crea`,
      });
      continue;
    }
    // PVP automático: coste del albarán × multiplicador, redondeado a 5 €
    const precioCompra = Number(n.precio_compra) || 0;
    let notaPrecio = "";
    if (ref.precio <= 0 && precioCompra > 0 && multiplicadorPrecio > 0) {
      ref.precio = Math.max(5, Math.round((precioCompra * multiplicadorPrecio) / 5) * 5);
      notaPrecio = ` · PVP ${ref.precio}€ (coste ${precioCompra}€ × ${multiplicadorPrecio})`;
    }
    resultado.nuevas_referencias!.push({
      ...ref,
      precio_compra: precioCompra > 0 ? precioCompra : null,
    });
    resultado.preview!.push({
      vino_id: -1,
      etiqueta: `${ref.bodega} — ${ref.nombre}${ref.anio ? ` (${ref.anio})` : ""}`,
      detalle: `Referencia nueva · ${ref.tipo} · ${ref.pais}${ref.uva ? ` · ${ref.uva}` : ""}${
        notaPrecio || (ref.precio > 0 ? ` · ${ref.precio}€` : " · precio pendiente")
      }`,
      qty: `+${ref.stock}`,
      direccion: "plus",
    });
  }
}

/** Importación de Excel determinista: el diff se calcula en código;
 *  la IA solo empareja las filas dudosas y clasifica las nuevas. */
async function importarExcelDeterminista(
  inv: { filas: FilaExcel[]; etiquetaFecha: string },
  vinos: Vino[],
  multiplicadorPrecio: number
): Promise<{ resultado: ResultadoDocumento; modelo: string }> {
  const { emparejados, filasSueltas, vinosSueltos, filasRepetidas } = emparejar(inv.filas, vinos);
  let modelo = "matching-determinista";
  const paresExtra: { fila: FilaExcel; vino: Vino }[] = [];
  const clasifNuevas = new Map<number, { tipo?: string; pais?: string; uva?: string }>();
  let filasNuevas: FilaExcel[] = filasSueltas;

  if (filasSueltas.length && vinosSueltos.length) {
    const listaFilas = filasSueltas
      .map(
        (f) =>
          `F${f.fila}: ${f.anio ?? "NV"} | ${f.bodega} | ${f.nombre}${f.talla ? ` | ${f.talla}` : ""}`
      )
      .join("\n");
    const listaVinos = vinosSueltos
      .map((v) => `ID${v.id}: ${v.anio ?? "NV"} | ${v.bodega} | ${v.nombre}`)
      .join("\n");
    const prompt = `Eres el sumiller digital de un restaurante. Tengo filas de un Excel de inventario que NO he podido casar automáticamente con el catálogo, y vinos del catálogo sin fila asignada.

FILAS DEL EXCEL SIN CASAR:
${listaFilas}

VINOS DEL CATÁLOGO SIN FILA:
${listaVinos}

Devuelve SOLO JSON compacto en una línea:
{"parejas":[{"fila":123,"id":45}],"nuevas":[{"fila":130,"tipo":"Tinto","pais":"España","uva":"Garnacha"}]}

REGLAS:
- Una pareja SOLO si es claramente EL MISMO vino (variaciones ortográficas, abreviaturas, orden bodega/nombre invertido).
- IMPORTANTE: cada añada es una referencia DISTINTA (el precio cambia con la cosecha). Solo empareja si la añada coincide o si una de las dos no está indicada. El mismo vino con otra añada NO se empareja: va a "nuevas" con su añada.
- Cada fila y cada id pueden aparecer como mucho una vez.
- Las filas que no casen con nada son "nuevas": deduce tipo (uno de Espumoso, Blanco, Rosado, Tinto, Dulce), pais y uva con tu conocimiento de vinos.
- Omite filas que no sean vinos reales. Sin markdown ni texto extra.`;
    try {
      const r = await llamarOpenRouter(
        [{ type: "text", text: prompt }],
        16000,
        process.env.OPENROUTER_MODEL_EXCEL || "google/gemini-3.5-flash"
      );
      modelo = `matching + ${r.modelo}`;
      const p = parseJsonIA(r.texto);
      const filaPor = new Map(filasSueltas.map((f) => [f.fila, f]));
      const vinoPor = new Map(vinosSueltos.map((v) => [v.id, v]));
      const usadasF = new Set<number>();
      const usadosV = new Set<number>();
      for (const par of (p.parejas ?? []) as { fila: number; id: number }[]) {
        const f = filaPor.get(Number(par.fila));
        const v = vinoPor.get(Number(par.id));
        if (f && v && !usadasF.has(f.fila) && !usadosV.has(v.id)) {
          paresExtra.push({ fila: f, vino: v });
          usadasF.add(f.fila);
          usadosV.add(v.id);
        }
      }
      for (const n of (p.nuevas ?? []) as {
        fila: number;
        tipo?: string;
        pais?: string;
        uva?: string;
      }[]) {
        if (!usadasF.has(Number(n.fila))) clasifNuevas.set(Number(n.fila), n);
      }
      filasNuevas = filasSueltas.filter((f) => !usadasF.has(f.fila));
    } catch {
      // Sin IA: las filas sueltas van todas como nuevas (el usuario revisa)
    }
  }

  const resultado: ResultadoDocumento = {
    proveedor_o_fecha: `Inventario Excel · columna ${inv.etiquetaFecha}`,
    movimientos: [],
    precios: [],
    nuevas_referencias: [],
    no_encontrados: [],
    bajas_sugeridas: [],
    preview: [],
  };

  const todosPares = [
    ...emparejados.map((e) => ({ fila: e.fila, vino: e.vino })),
    ...paresExtra,
  ];
  for (const { fila, vino } of todosPares) {
    // Celda de cantidad en blanco ≠ contar 0: no se toca el stock,
    // se propone dar de baja la referencia
    const delta = fila.sinCantidad ? 0 : fila.stock - vino.stock;
    const pv = Math.round(fila.precioVenta ?? 0);
    const cambiaPrecio = pv > 0 && pv !== Math.round(Number(vino.precio));
    const pc = Math.round((fila.precioCompra ?? 0) * 100) / 100;
    const cambiaCompra =
      pc > 0 && pc !== Math.round(Number(vino.precio_compra ?? 0) * 100) / 100;
    const cambiaProv =
      !!fila.proveedor && fila.proveedor !== (vino.proveedor ?? "");
    if (delta !== 0) {
      resultado.movimientos.push({
        vino_id: vino.id,
        qty: delta,
        nota: `Excel ${inv.etiquetaFecha}: ${vino.stock} → ${fila.stock}`,
      });
    }
    if (cambiaPrecio || cambiaCompra || cambiaProv) {
      resultado.precios!.push({
        vino_id: vino.id,
        ...(cambiaPrecio ? { precio_nuevo: pv } : {}),
        ...(cambiaCompra ? { precio_compra_nuevo: pc } : {}),
        ...(cambiaProv ? { proveedor_nuevo: fila.proveedor as string } : {}),
      });
    }
    if (fila.sinCantidad) {
      resultado.bajas_sugeridas!.push({
        vino_id: vino.id,
        etiqueta: `${vino.bodega} — ${vino.nombre}${vino.anio ? ` (${vino.anio})` : ""}`,
        motivo: "sin_cantidad",
        stock: vino.stock,
      });
    }
    if (delta !== 0 || cambiaPrecio || cambiaCompra || cambiaProv) {
      resultado.preview!.push({
        vino_id: vino.id,
        etiqueta: `${vino.bodega} — ${vino.nombre}${vino.anio ? ` (${vino.anio})` : ""}`,
        detalle: [
          delta !== 0 ? `Stock: ${vino.stock} → ${fila.stock}` : "",
          cambiaPrecio ? `Venta: ${vino.precio}€ → ${pv}€` : "",
          cambiaCompra
            ? `Coste: ${vino.precio_compra ? `${vino.precio_compra}€` : "—"} → ${pc}€`
            : "",
          cambiaProv ? `Proveedor: ${fila.proveedor}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        qty: delta !== 0 ? String(fila.stock) : "·",
        direccion: delta >= 0 ? "plus" : "minus",
      });
    }
  }

  // Filas repetidas dentro del propio Excel: se avisa y no se duplican
  for (const f of filasRepetidas) {
    resultado.no_encontrados!.push({
      texto: `Fila ${f.fila}: «${f.bodega} ${f.nombre}${f.anio ? ` (${f.anio})` : ""}» está repetida en el Excel — solo se cuenta la primera aparición`,
      qty: f.stock,
    });
  }

  for (const f of filasNuevas) {
    if (f.stock <= 0 && !f.precioVenta && !f.precioCompra) continue;
    // Antes de crearla, ¿se parece mucho a algo que ya existe? Los duplicados
    // del 02/08 nacieron de crear referencias sin este aviso.
    const sospecha = posibleDuplicado(f, vinos);
    const clasif = clasifNuevas.get(f.fila) ?? {};
    const tipoVino = TIPOS_VINO.includes(clasif.tipo as TipoVino)
      ? (clasif.tipo as TipoVino)
      : "Tinto";
    let precio = Math.round(f.precioVenta ?? 0);
    let notaPrecio = "";
    if (precio <= 0 && (f.precioCompra ?? 0) > 0 && multiplicadorPrecio > 0) {
      precio = Math.max(
        5,
        Math.round(((f.precioCompra as number) * multiplicadorPrecio) / 5) * 5
      );
      notaPrecio = ` · PVP ${precio}€ (coste ${f.precioCompra}€ × ${multiplicadorPrecio})`;
    }
    const nombreConTalla = f.talla ? `${f.nombre} ${f.talla}` : f.nombre;
    resultado.nuevas_referencias!.push({
      anio: f.anio,
      bodega: f.bodega,
      nombre: nombreConTalla,
      tipo: tipoVino,
      pais: clasif.pais?.trim() || "España",
      uva: clasif.uva?.trim() || null,
      precio,
      precio_compra: f.precioCompra ?? null,
      proveedor: f.proveedor,
      stock: f.stock,
    });
    resultado.preview!.push({
      vino_id: -1,
      etiqueta: `${f.bodega} — ${nombreConTalla}${f.anio ? ` (${f.anio})` : ""}`,
      detalle: `Referencia nueva · ${tipoVino}${clasif.pais ? ` · ${clasif.pais}` : ""}${
        notaPrecio || (precio > 0 ? ` · ${precio}€` : " · precio pendiente")
      }${
        sospecha
          ? ` · ⚠ parecida a «${sospecha.vino.bodega} ${sospecha.vino.nombre}${sospecha.vino.anio ? ` (${sospecha.vino.anio})` : ""}» — comprueba que no sea la misma`
          : ""
      }`,
      qty: `+${f.stock}`,
      direccion: "plus",
    });
  }

  // Vinos de la bodega que el Excel no menciona: candidatos a baja
  const idsExtra = new Set(paresExtra.map((p) => p.vino.id));
  for (const v of vinosSueltos) {
    if (idsExtra.has(v.id)) continue;
    resultado.bajas_sugeridas!.push({
      vino_id: v.id,
      etiqueta: `${v.bodega} — ${v.nombre}${v.anio ? ` (${v.anio})` : ""}`,
      motivo: "no_en_excel",
      stock: v.stock,
    });
  }

  return { resultado, modelo };
}

/** Casa las líneas de un informe de ventas del TPV con el catálogo.
 *  Mismo esquema de tres tramos que la carta: automático / sugerencia / manual. */
async function casarVentasTpv(
  ventas: VentaTpv[],
  vinos: Vino[],
  supabase: SupabaseLike
): Promise<ResultadoDocumento> {
  const resultado: ResultadoDocumento = {
    proveedor_o_fecha: `Ventas del TPV · ${ventas.length} artículos`,
    movimientos: [],
    precios: [],
    nuevas_referencias: [],
    no_encontrados: [],
    bajas_sugeridas: [],
    carta_sugerencias: [],
    tpv_items: [],
    preview: [],
  };

  // Nombres ya confirmados en cierres o cartas anteriores
  const { data: aliasRows } = await supabase
    .from("alias_carta")
    .select("texto_norm, vino_id");
  const alias = new Map(
    (aliasRows ?? []).map((a: { texto_norm: string; vino_id: number }) => [
      a.texto_norm,
      a.vino_id,
    ])
  );
  const porId = new Map(vinos.map((v) => [v.id, v]));

  const pendientes: VentaTpv[] = [];
  for (const v of ventas) {
    const id = alias.get(v.texto.toLowerCase().trim());
    const vino = id ? porId.get(id) : undefined;
    if (vino) {
      resultado.tpv_items!.push({ vino_id: vino.id, qty: -v.unidades, texto: v.texto });
    } else {
      pendientes.push(v);
    }
  }

  const { casados, sinCasar } = emparejarCarta(
    pendientes.map((v) => ({ texto: v.texto })),
    vinos,
    UMBRAL_SUGERENCIA,
    true // el informe del TPV está lleno de comida: modo estricto
  );
  const unidadesDe = (texto: string) =>
    pendientes.find((p) => p.texto === texto)?.unidades ?? 0;

  for (const c of casados) {
    const qty = unidadesDe(c.linea.texto);
    if (c.score >= UMBRAL_AUTO) {
      resultado.tpv_items!.push({
        vino_id: c.vino.id,
        qty: -qty,
        texto: c.linea.texto,
      });
    } else {
      resultado.carta_sugerencias!.push({
        texto: c.linea.texto,
        vino_id: c.vino.id,
        etiqueta: `${c.vino.bodega} — ${c.vino.nombre}${c.vino.anio ? ` (${c.vino.anio})` : ""}`,
        score: Math.round(c.score * 100) / 100,
        precio: null,
        qty,
      });
    }
  }

  // Lo que no casa suele ser comida y bebida que no es vino: solo se listan
  // las líneas que podrían ser vino para no ensuciar la revisión
  resultado.carta_sin_casar = sinCasar.map((l) => ({
    texto: l.texto,
    precio: null,
    qty: unidadesDe(l.texto),
  }));

  for (const it of resultado.tpv_items!) {
    const w = porId.get(it.vino_id)!;
    resultado.preview!.push({
      vino_id: w.id,
      etiqueta: `${w.bodega} — ${w.nombre}${w.anio ? ` (${w.anio})` : ""}`,
      detalle: `"${it.texto}" · quedan ${Math.max(0, w.stock + it.qty)} de ${w.stock}`,
      qty: `−${Math.abs(it.qty)}`,
      direccion: "minus",
    });
  }
  return resultado;
}

function parseJsonIA(raw: string): Record<string, unknown> {
  const limpio = raw
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const ini = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  const candidato = ini !== -1 && fin > ini ? limpio.slice(ini, fin + 1) : limpio;
  try {
    return JSON.parse(candidato);
  } catch {
    // La IA a veces emite JSON con comillas sin escapar (nombres de vinos
    // con comillas) o pequeños defectos — jsonrepair los corrige
    try {
      return JSON.parse(jsonrepair(candidato));
    } catch {
      console.error(
        "[documentos] respuesta IA no parseable (primeros 2000 chars):",
        limpio.slice(0, 2000)
      );
      throw new Error(
        "La IA devolvió una respuesta incompleta o no válida. Vuelve a intentarlo; si persiste, prueba con un archivo más pequeño."
      );
    }
  }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const tipo = form.get("tipo") as "albaran" | "cierre" | "excel" | "carta" | null;
    if (!file || !tipo || !["albaran", "cierre", "excel", "carta"].includes(tipo)) {
      return NextResponse.json({ error: "Petición inválida" }, { status: 400 });
    }

    // Catálogo actual desde la BD (los IDs que devuelve la IA son IDs reales)
    const { data: vinosData, error: vinosError } = await supabase
      .from("vinos")
      .select("*")
      .eq("activo", true)
      .order("id");
    if (vinosError) throw new Error(vinosError.message);
    const vinos = (vinosData ?? []) as Vino[];
    const porId = new Map(vinos.map((v) => [v.id, v]));

    // Multiplicador de PVP configurable por el equipo (coste × M)
    const { data: ajusteMult } = await supabase
      .from("ajustes")
      .select("valor")
      .eq("clave", "multiplicador_precio")
      .maybeSingle();
    const multiplicadorPrecio = Number(ajusteMult?.valor) || 1.8;

    const buffer = Buffer.from(await file.arrayBuffer());
    const nombreLower = file.name.toLowerCase();
    const esHojaCalculo = /\.(csv|xlsx|xls)$/.test(nombreLower);

    function aCsv(): string {
      let csv: string;
      if (nombreLower.endsWith(".csv")) {
        csv = buffer.toString("utf8");
      } else {
        // Si hay varias hojas, elegir la de más contenido (los Excel reales
        // suelen traer hojas viejas/copias al lado de la buena)
        const wb = XLSX.read(buffer, { type: "buffer" });
        const csvs = wb.SheetNames.map((n) =>
          XLSX.utils.sheet_to_csv(wb.Sheets[n])
        );
        csv = csvs.reduce((a, b) => (b.length > a.length ? b : a), "");
      }
      if (csv.length > 200000) csv = csv.slice(0, 200000) + "\n...(truncado)";
      return csv;
    }

    // La columna de stock vigente se determina en código (fecha más reciente
    // de la cabecera, formato dd/mm/aa) — no se deja a criterio de la IA
    function ultimaColumnaFecha(csv: string): string | null {
      const cabecera = csv.split("\n", 1)[0] ?? "";
      let mejor: { txt: string; val: number } | null = null;
      for (const m of cabecera.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)) {
        const dia = Number(m[1]);
        const mes = Number(m[2]);
        let anio = Number(m[3]);
        if (anio < 100) anio += 2000;
        const val = anio * 10000 + mes * 100 + dia;
        if (!mejor || val > mejor.val) mejor = { txt: m[0], val };
      }
      return mejor?.txt ?? null;
    }

    // ── Excel de inventario: vía determinista (diff en código; la IA solo
    //    empareja filas dudosas). Si el archivo no tiene la estructura
    //    esperada, cae al método clásico con IA. ──
    let resultadoFinal: ResultadoDocumento | null = null;
    let modeloFinal = "";
    if (tipo === "excel" && esHojaCalculo && !nombreLower.endsWith(".csv")) {
      const inv = parsearInventario(buffer);
      if (inv) {
        const det = await importarExcelDeterminista(inv, vinos, multiplicadorPrecio);
        resultadoFinal = det.resultado;
        modeloFinal = det.modelo;
      }
    }

    // Informe de ventas del TPV (HioPOS Analytics → "Por artículos" → Excel):
    // tabular y exacto, se parsea y casa en código sin pasar por la IA
    if (tipo === "cierre" && esHojaCalculo) {
      const informe = parsearVentasTpv(buffer, nombreLower.endsWith(".csv"));
      if (informe && informe.ventas.length) {
        resultadoFinal = await casarVentasTpv(informe.ventas, vinos, supabase);
        modeloFinal = `TPV · hoja "${informe.hoja}" · casado en código`;
      }
    }

    if (!resultadoFinal) {
    // Construir el contenido para la IA según el tipo de archivo
    let parts: ContentPart[];
    if (tipo === "carta") {
      const promptTxt = promptExtraerCarta();
      if (esHojaCalculo) {
        parts = [
          { type: "text", text: `${promptTxt}\n\nCONTENIDO DE LA CARTA:\n${aCsv()}` },
        ];
      } else {
        const b64 = buffer.toString("base64");
        const mime = file.type || "image/jpeg";
        const dataUrl = `data:${mime};base64,${b64}`;
        parts = [
          mime === "application/pdf"
            ? { type: "file", file: { filename: file.name, file_data: dataUrl } }
            : { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: promptTxt },
        ];
      }
    } else if (tipo === "excel") {
      const csv = aCsv();
      parts = [{ type: "text", text: promptExcel(csv, vinos, ultimaColumnaFecha(csv)) }];
    } else if (esHojaCalculo) {
      // Albarán o cierre de caja exportado del TPV como CSV/Excel:
      // texto exacto, sin OCR — máxima precisión
      parts = [
        {
          type: "text",
          text: `${promptAlbaranCierre(tipo, vinos)}\n\nCONTENIDO DEL DOCUMENTO (CSV exportado del TPV):\n${aCsv()}`,
        },
      ];
    } else {
      const b64 = buffer.toString("base64");
      const mime = file.type || "image/jpeg";
      const dataUrl = `data:${mime};base64,${b64}`;
      const filePart: ContentPart =
        mime === "application/pdf"
          ? { type: "file", file: { filename: file.name, file_data: dataUrl } }
          : { type: "image_url", image_url: { url: dataUrl } };
      parts = [filePart, { type: "text", text: promptAlbaranCierre(tipo, vinos) }];
    }

    // Un Excel completo puede requerir ~300 actualizaciones en la respuesta:
    // hace falta mucho más espacio de salida que para un albarán.
    // El casado de cientos de filas contra el catálogo necesita un modelo
    // potente; los albaranes/cierres funcionan bien con el modelo rápido.
    // OJO: se usan nombres de variable nuevos (OPENROUTER_MODEL_DOCS/_EXCEL)
    // a propósito — la antigua OPENROUTER_MODEL quedó configurada en Vercel
    // con un modelo obsoleto y se ignora deliberadamente.
    const modeloTarea =
      tipo === "excel"
        ? process.env.OPENROUTER_MODEL_EXCEL || "google/gemini-3.5-flash"
        : process.env.OPENROUTER_MODEL_DOCS || "google/gemini-3.5-flash";
    const { texto, modelo } = await llamarOpenRouter(
      parts,
      tipo === "excel" || tipo === "carta" ? 60000 : 16000,
      modeloTarea
    );
    const parsed = parseJsonIA(texto);

    // Normalizar a la forma que consume la RPC aplicar_documento
    const resultado: ResultadoDocumento = {
      movimientos: [],
      precios: [],
      nuevas_referencias: [],
      no_encontrados: [],
      bajas_sugeridas: [],
      carta_sugerencias: [],
      preview: [],
    };

    if (tipo === "carta") {
      // La IA solo transcribe; el casado con el catálogo se hace en código
      // (exhaustivo por construcción) en tres tramos de confianza.
      const lineas = ((parsed.lineas ?? []) as Record<string, unknown>[])
        .map((l) => ({
          texto: String(l.texto ?? "").trim(),
          bodega: l.bodega ? String(l.bodega) : null,
          nombre: l.nombre ? String(l.nombre) : null,
          anio: Number(l.anio) || null,
          precio: Number(l.precio) || null,
        }))
        .filter((l) => l.texto || l.nombre);

      // 1) Correspondencias ya confirmadas en cartas anteriores
      const { data: aliasRows } = await supabase
        .from("alias_carta")
        .select("texto_norm, vino_id");
      const alias = new Map(
        (aliasRows ?? []).map((a) => [a.texto_norm as string, a.vino_id as number])
      );

      const items: { vino_id: number; precio: number | null; texto: string }[] = [];
      const usados = new Set<number>();
      const pendientes: typeof lineas = [];
      for (const l of lineas) {
        const id = alias.get(l.texto.toLowerCase().trim());
        if (id && porId.has(id) && !usados.has(id)) {
          usados.add(id);
          items.push({ vino_id: id, precio: l.precio, texto: l.texto });
        } else {
          pendientes.push(l);
        }
      }

      // 2) Emparejado determinista sobre el catálogo completo
      const libres = vinos.filter((v) => !usados.has(v.id));
      const { casados, sinCasar } = emparejarCarta(pendientes, libres, UMBRAL_SUGERENCIA);
      for (const c of casados) {
        if (c.score >= UMBRAL_AUTO) {
          usados.add(c.vino.id);
          items.push({
            vino_id: c.vino.id,
            precio: c.linea.precio ?? null,
            texto: c.linea.texto,
          });
        } else {
          resultado.carta_sugerencias!.push({
            texto: c.linea.texto,
            vino_id: c.vino.id,
            etiqueta: `${c.vino.bodega} — ${c.vino.nombre}${c.vino.anio ? ` (${c.vino.anio})` : ""}`,
            score: Math.round(c.score * 100) / 100,
            precio: c.linea.precio ?? null,
          });
        }
      }
      // Muchas líneas "sin casar" son en realidad el mismo vino con otra
      // añada: distinguirlo evita que parezcan errores de lectura
      resultado.carta_sin_casar = sinCasar.map((l) => {
        const otra = mismaReferenciaOtraAnada(l, libres);
        return {
          texto: l.texto,
          precio: l.precio ?? null,
          ...(otra
            ? {
                nota: `El inventario tiene esta referencia con añada ${otra.anio} (${otra.bodega} — ${otra.nombre})`,
              }
            : {}),
        };
      });

      resultado.carta_items = items;
      resultado.carta_ids = items.map((i) => i.vino_id);

      // Previsualización: solo lo que cambia
      for (const it of items) {
        const w = porId.get(it.vino_id)!;
        const pv = Math.round(Number(it.precio) || 0);
        const cambiaPrecio = pv > 0 && pv !== Math.round(Number(w.precio));
        if (!w.en_carta || cambiaPrecio) {
          resultado.preview!.push({
            vino_id: w.id,
            etiqueta: `${w.bodega} — ${w.nombre}${w.anio ? ` (${w.anio})` : ""}`,
            detalle: [
              w.en_carta ? "Ya estaba en carta" : "Entra en carta",
              cambiaPrecio ? `Precio: ${w.precio}€ → ${pv}€` : "",
            ]
              .filter(Boolean)
              .join(" · "),
            qty: pv > 0 ? `${pv} €` : "carta",
            direccion: "plus",
          });
        }
      }
      resultado.proveedor_o_fecha = `Carta de vinos · ${lineas.length} líneas leídas`;
    } else if (tipo === "excel") {
      const actualizaciones = (parsed.actualizaciones ?? []) as {
        id: number;
        stock_nuevo: number;
        precio_nuevo?: number;
      }[];
      for (const u of actualizaciones) {
        const w = porId.get(Number(u.id));
        if (!w) continue;
        const stockNuevo = Math.max(0, Math.round(Number(u.stock_nuevo) || 0));
        const delta = stockNuevo - w.stock;
        if (delta !== 0) {
          resultado.movimientos.push({
            vino_id: w.id,
            qty: delta,
            nota: `Excel: stock ${w.stock} → ${stockNuevo}`,
          });
        }
        const precioNuevo = Number(u.precio_nuevo) || 0;
        if (precioNuevo > 0 && precioNuevo !== w.precio) {
          resultado.precios!.push({ vino_id: w.id, precio_nuevo: precioNuevo });
        }
        if (delta !== 0 || (precioNuevo > 0 && precioNuevo !== w.precio)) {
          resultado.preview!.push({
            vino_id: w.id,
            etiqueta: `${w.bodega} — ${w.nombre}${w.anio ? ` (${w.anio})` : ""}`,
            detalle: [
              delta !== 0 ? `Stock: ${w.stock} → ${stockNuevo}` : "Stock sin cambios",
              precioNuevo > 0 && precioNuevo !== w.precio
                ? `Precio: ${w.precio}€ → ${precioNuevo}€`
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
            qty: String(stockNuevo),
            direccion: delta >= 0 ? "plus" : "minus",
          });
        }
      }
      recogerNuevasReferencias(parsed, resultado, vinos, multiplicadorPrecio);
      const noId = (parsed.no_identificados ?? []) as { texto: string }[];
      resultado.no_encontrados = noId.map((x) => ({ texto: String(x.texto || "") }));
    } else {
      const esAlbaran = tipo === "albaran";
      const items = (parsed.items ?? []) as {
        id: number;
        qty: number;
        texto_original?: string;
        confianza?: string;
      }[];
      resultado.proveedor_o_fecha = String(parsed.proveedor_o_fecha || "");
      for (const item of items) {
        const w = porId.get(Number(item.id));
        const qty = Math.round(Number(item.qty) || 0);
        if (!w || qty <= 0) continue;
        // En cierres nunca restamos por debajo de 0 (igual que la app original)
        const qtyFinal = esAlbaran ? qty : -Math.min(qty, w.stock);
        if (qtyFinal !== 0) {
          resultado.movimientos.push({
            vino_id: w.id,
            qty: qtyFinal,
            nota: item.texto_original || undefined,
          });
        }
        resultado.preview!.push({
          vino_id: w.id,
          etiqueta: `${item.confianza === "baja" ? "⚠ " : ""}${w.bodega} — ${w.nombre}`,
          detalle: `"${item.texto_original || ""}"${item.confianza === "baja" ? " · confianza baja" : ""}`,
          qty: `${esAlbaran ? "+" : "−"}${qty}`,
          direccion: esAlbaran ? "plus" : "minus",
          confianza: item.confianza,
        });
      }
      // En albaranes, los vinos fuera de catálogo se dan de alta como referencia nueva
      if (esAlbaran) {
        recogerNuevasReferencias(parsed, resultado, vinos, multiplicadorPrecio);
      }
      const noEnc = (parsed.no_encontrados ?? []) as { texto: string; qty?: number }[];
      resultado.no_encontrados = noEnc.map((x) => ({
        texto: String(x.texto || ""),
        qty: Number(x.qty) || undefined,
      }));
    }
    resultadoFinal = resultado;
    modeloFinal = modelo;
    }

    // ¿Este albarán ya se subió? Mismo fichero (nombre) o mismo proveedor con
    // el mismo número de líneas en las últimas 2 semanas ⇒ probable duplicado.
    // Aplicarlo dos veces sumaría las botellas dos veces.
    if (tipo === "albaran") {
      const desde = new Date(Date.now() - 14 * 86400000).toISOString();
      const { data: previos } = await supabase
        .from("documentos")
        .select("id, nombre_archivo, aplicado, created_at, resultado")
        .eq("tipo", "albaran")
        .gte("created_at", desde)
        .order("created_at", { ascending: false })
        .limit(30);
      const nLineas =
        (resultadoFinal.movimientos?.length ?? 0) +
        (resultadoFinal.nuevas_referencias?.length ?? 0);
      const dup = (previos ?? []).find((d) => {
        if (d.nombre_archivo === file.name) return true;
        const r = d.resultado as ResultadoDocumento | null;
        const prevLineas =
          (r?.movimientos?.length ?? 0) + (r?.nuevas_referencias?.length ?? 0);
        return (
          !!resultadoFinal.proveedor_o_fecha &&
          r?.proveedor_o_fecha === resultadoFinal.proveedor_o_fecha &&
          prevLineas === nLineas &&
          nLineas > 0
        );
      });
      if (dup) {
        resultadoFinal.aviso_duplicado = `Este albarán se parece a "${dup.nombre_archivo}" subido el ${new Date(dup.created_at).toLocaleDateString("es-ES")}${dup.aplicado ? " y YA APLICADO" : " (sin aplicar)"}. Si es el mismo, no lo apliques dos veces.`;
      }
    }

    // Guardar el archivo original en Storage (auditoría)
    const storagePath = `${Date.now()}_${file.name.replace(/[^\w.\-]/g, "_")}`;
    await supabase.storage.from("documentos").upload(storagePath, buffer, {
      contentType: file.type || "application/octet-stream",
    });

    // Registrar el documento (pendiente de aplicar)
    const { data: doc, error: docError } = await supabase
      .from("documentos")
      .insert({
        tipo,
        nombre_archivo: file.name,
        storage_path: storagePath,
        modelo_ia: modeloFinal,
        resultado: resultadoFinal,
        user_id: user.id,
      })
      .select("id")
      .single();
    if (docError) throw new Error(docError.message);

    return NextResponse.json({ documento_id: doc.id, resultado: resultadoFinal });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error inesperado";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
