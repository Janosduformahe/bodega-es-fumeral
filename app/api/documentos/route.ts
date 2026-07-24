import { NextResponse, type NextRequest } from "next/server";
import { jsonrepair } from "jsonrepair";
import * as XLSX from "xlsx";
import { emparejar, parsearInventario, type FilaExcel } from "@/lib/excel";
import { createClient } from "@/lib/supabase/server";
import { promptAlbaranCierre, promptExcel } from "@/lib/prompts";
import type { ResultadoDocumento, TipoVino, Vino } from "@/lib/types";

export const maxDuration = 120; // la lectura IA de un PDF puede tardar

const TIPOS_VINO: TipoVino[] = ["Espumoso", "Blanco", "Rosado", "Tinto", "Dulce"];

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
    resultado.nuevas_referencias!.push(ref);
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
  const { emparejados, filasSueltas, vinosSueltos } = emparejar(inv.filas, vinos);
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
    preview: [],
  };

  const todosPares = [
    ...emparejados.map((e) => ({ fila: e.fila, vino: e.vino })),
    ...paresExtra,
  ];
  for (const { fila, vino } of todosPares) {
    const delta = fila.stock - vino.stock;
    const pv = Math.round(fila.precioVenta ?? 0);
    const cambiaPrecio = pv > 0 && pv !== Math.round(Number(vino.precio));
    if (delta !== 0) {
      resultado.movimientos.push({
        vino_id: vino.id,
        qty: delta,
        nota: `Excel ${inv.etiquetaFecha}: ${vino.stock} → ${fila.stock}`,
      });
    }
    if (cambiaPrecio) {
      resultado.precios!.push({ vino_id: vino.id, precio_nuevo: pv });
    }
    if (delta !== 0 || cambiaPrecio) {
      resultado.preview!.push({
        vino_id: vino.id,
        etiqueta: `${vino.bodega} — ${vino.nombre}${vino.anio ? ` (${vino.anio})` : ""}`,
        detalle: [
          delta !== 0 ? `Stock: ${vino.stock} → ${fila.stock}` : "",
          cambiaPrecio ? `Precio: ${vino.precio}€ → ${pv}€` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        qty: String(fila.stock),
        direccion: delta >= 0 ? "plus" : "minus",
      });
    }
    if (fila.anio !== null && vino.anio !== null && fila.anio !== vino.anio) {
      resultado.no_encontrados!.push({
        texto: `Añada distinta en "${vino.bodega} — ${vino.nombre}": catálogo ${vino.anio}, Excel ${fila.anio} (no se cambia sola)`,
      });
    }
  }

  for (const f of filasNuevas) {
    if (f.stock <= 0 && !f.precioVenta && !f.precioCompra) continue;
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
      stock: f.stock,
    });
    resultado.preview!.push({
      vino_id: -1,
      etiqueta: `${f.bodega} — ${nombreConTalla}${f.anio ? ` (${f.anio})` : ""}`,
      detalle: `Referencia nueva · ${tipoVino}${clasif.pais ? ` · ${clasif.pais}` : ""}${
        notaPrecio || (precio > 0 ? ` · ${precio}€` : " · precio pendiente")
      }`,
      qty: `+${f.stock}`,
      direccion: "plus",
    });
  }

  // Vinos de la bodega que el Excel no menciona: se dejan como están
  const idsExtra = new Set(paresExtra.map((p) => p.vino.id));
  const noEnExcel = vinosSueltos.filter((v) => !idsExtra.has(v.id) && v.stock > 0);
  if (noEnExcel.length) {
    resultado.no_encontrados!.push({
      texto: `${noEnExcel.length} vinos de la bodega no aparecen en el Excel (se dejan sin cambios): ${noEnExcel
        .slice(0, 5)
        .map((v) => `${v.bodega} ${v.nombre}`)
        .join("; ")}${noEnExcel.length > 5 ? "…" : ""}`,
    });
  }

  return { resultado, modelo };
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
    const tipo = form.get("tipo") as "albaran" | "cierre" | "excel" | null;
    if (!file || !tipo || !["albaran", "cierre", "excel"].includes(tipo)) {
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

    if (!resultadoFinal) {
    // Construir el contenido para la IA según el tipo de archivo
    let parts: ContentPart[];
    if (tipo === "excel") {
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
      tipo === "excel" ? 60000 : 16000,
      modeloTarea
    );
    const parsed = parseJsonIA(texto);

    // Normalizar a la forma que consume la RPC aplicar_documento
    const resultado: ResultadoDocumento = {
      movimientos: [],
      precios: [],
      nuevas_referencias: [],
      no_encontrados: [],
      preview: [],
    };

    if (tipo === "excel") {
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
