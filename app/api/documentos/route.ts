import { NextResponse, type NextRequest } from "next/server";
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

async function llamarOpenRouter(parts: ContentPart[]): Promise<{ texto: string; modelo: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Falta OPENROUTER_API_KEY en las variables de entorno");
  }
  const modelo = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";

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
      max_tokens: 4000,
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

function parseJsonIA(raw: string): Record<string, unknown> {
  const limpio = raw
    .trim()
    .replace(/^```json?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(limpio);
  } catch {
    throw new Error("No se pudo interpretar la respuesta de la IA. Inténtalo de nuevo.");
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

    // Construir el contenido para la IA según el tipo de archivo
    let parts: ContentPart[];
    if (tipo === "excel") {
      let csv: string;
      if (file.name.toLowerCase().endsWith(".csv")) {
        csv = buffer.toString("utf8");
      } else {
        const wb = XLSX.read(buffer, { type: "buffer" });
        csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
      }
      if (csv.length > 60000) csv = csv.slice(0, 60000) + "\n...(truncado)";
      parts = [{ type: "text", text: promptExcel(csv, vinos) }];
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

    const { texto, modelo } = await llamarOpenRouter(parts);
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
      const nuevas = (parsed.nuevas_referencias ?? []) as Record<string, unknown>[];
      for (const n of nuevas) {
        const tipoVino = TIPOS_VINO.includes(n.tipo as TipoVino)
          ? (n.tipo as TipoVino)
          : "Tinto";
        const anio = Number(n.anio) || null;
        const ref = {
          anio,
          bodega: String(n.bodega || "").trim(),
          nombre: String(n.nombre || "").trim(),
          tipo: tipoVino,
          pais: String(n.pais || "España").trim(),
          uva: n.uva ? String(n.uva) : null,
          precio: Number(n.precio) || 0,
          stock: Math.max(0, Math.round(Number(n.stock) || 0)),
        };
        if (!ref.bodega || !ref.nombre) continue;
        resultado.nuevas_referencias!.push(ref);
        resultado.preview!.push({
          vino_id: -1,
          etiqueta: `✨ ${ref.bodega} — ${ref.nombre}${ref.anio ? ` (${ref.anio})` : ""}`,
          detalle: `${ref.tipo} · ${ref.pais}${ref.uva ? ` · ${ref.uva}` : ""} · ${ref.precio}€`,
          qty: `+${ref.stock}`,
          direccion: "plus",
        });
      }
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
