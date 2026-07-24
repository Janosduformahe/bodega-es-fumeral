import { NextResponse, type NextRequest } from "next/server";
import { jsonrepair } from "jsonrepair";
import * as XLSX from "xlsx";
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
  vinos: Vino[]
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
    resultado.nuevas_referencias!.push(ref);
    resultado.preview!.push({
      vino_id: -1,
      etiqueta: `${ref.bodega} — ${ref.nombre}${ref.anio ? ` (${ref.anio})` : ""}`,
      detalle: `Referencia nueva · ${ref.tipo} · ${ref.pais}${ref.uva ? ` · ${ref.uva}` : ""}${
        ref.precio > 0 ? ` · ${ref.precio}€` : " · precio pendiente"
      }`,
      qty: `+${ref.stock}`,
      direccion: "plus",
    });
  }
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
    const modeloTarea =
      tipo === "excel"
        ? process.env.OPENROUTER_MODEL_EXCEL || "anthropic/claude-sonnet-4.5"
        : process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";
    const { texto, modelo } = await llamarOpenRouter(
      parts,
      tipo === "excel" ? 32000 : 8000,
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
      recogerNuevasReferencias(parsed, resultado, vinos);
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
        recogerNuevasReferencias(parsed, resultado, vinos);
      }
      const noEnc = (parsed.no_encontrados ?? []) as { texto: string; qty?: number }[];
      resultado.no_encontrados = noEnc.map((x) => ({
        texto: String(x.texto || ""),
        qty: Number(x.qty) || undefined,
      }));
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
        modelo_ia: modelo,
        resultado,
        user_id: user.id,
      })
      .select("id")
      .single();
    if (docError) throw new Error(docError.message);

    return NextResponse.json({ documento_id: doc.id, resultado });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error inesperado";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
