// Lectura de un informe de ventas exportado del TPV (HioPOS Analytics →
// pestaña "Por artículos" → Exportar a Excel). Se parsea en código: el
// fichero es tabular y exacto, no hace falta IA para leerlo.
import * as XLSX from "xlsx";

export type VentaTpv = {
  texto: string; // nombre del artículo tal cual sale en el TPV
  unidades: number;
  importe: number | null;
};

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%. ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Cabeceras típicas de HioPOS Analytics y de otros TPV */
const COL_ARTICULO = ["articulo", "artículo", "producto", "descripcion", "nombre"];
const COL_UNIDADES = ["uds.v", "uds v", "udsv", "unidades", "cantidad", "uds", "qty"];
const COL_IMPORTE = ["venta", "importe", "total", "base"];

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  // "1.234,50 €" → 1234.50
  const s = String(v)
    .replace(/[€\s]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const n = Number(s);
  return isNaN(n) ? null : n;
}

/** Localiza la cabecera y devuelve las líneas de venta por artículo.
 *  Devuelve null si el fichero no parece un informe de ventas. */
export function parsearVentasTpv(
  buffer: Buffer,
  esCsv: boolean
): { ventas: VentaTpv[]; hoja: string } | null {
  const wb = esCsv
    ? XLSX.read(buffer.toString("utf8"), { type: "string" })
    : XLSX.read(buffer, { type: "buffer" });

  for (const nombreHoja of wb.SheetNames) {
    const filas: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], {
      header: 1,
    });
    if (!filas.length) continue;

    // La cabecera puede no estar en la primera fila (títulos, filtros, logos)
    for (let h = 0; h < Math.min(12, filas.length); h++) {
      const celdas = (filas[h] ?? []).map(norm);
      const iArt = celdas.findIndex((c) => COL_ARTICULO.some((k) => c === norm(k)));
      // "Uds.V" exacto antes que "Uds.V %ST" (que es un porcentaje)
      const iUds = celdas.findIndex(
        (c) => COL_UNIDADES.some((k) => c === norm(k)) && !c.includes("%")
      );
      if (iArt === -1 || iUds === -1) continue;
      const iImp = celdas.findIndex(
        (c) => COL_IMPORTE.some((k) => c === norm(k)) && !c.includes("%")
      );

      const ventas: VentaTpv[] = [];
      for (let r = h + 1; r < filas.length; r++) {
        const fila = filas[r] ?? [];
        const texto = String(fila[iArt] ?? "").trim();
        const unidades = num(fila[iUds]);
        if (!texto || unidades === null) continue;
        // Filas de total/subtotal
        if (/^(total|subtotal|suma)/i.test(texto)) continue;
        if (unidades <= 0) continue;
        ventas.push({
          texto,
          unidades: Math.round(unidades),
          importe: iImp >= 0 ? num(fila[iImp]) : null,
        });
      }
      if (ventas.length >= 1) return { ventas, hoja: nombreHoja };
    }
  }
  return null;
}
