// Parseo determinista del Excel de inventario + matching con el catálogo.
// La IA solo interviene para emparejar los casos que el matching por nombre
// no resuelve — el diff (stock/precios) se calcula SIEMPRE en código.
import * as XLSX from "xlsx";
import type { Vino } from "./types";

export type FilaExcel = {
  fila: number;
  bodega: string;
  nombre: string;
  anio: number | null;
  talla: string | null;
  stock: number; // columna de fecha más reciente
  /** true si la celda de cantidad está en blanco (≠ contar 0 botellas):
   *  no se toca el stock y la referencia se propone para dar de baja */
  sinCantidad: boolean;
  proveedor: string | null;
  precioVenta: number | null;
  precioCompra: number | null;
};

export const normalizar = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (s: string) =>
  new Set(normalizar(s).split(" ").filter((t) => t.length > 2));

/** Serial de Excel o texto dd/mm/aa → valor ordenable AAAAMMDD, o null */
function fechaDeCabecera(celda: unknown): number | null {
  if (typeof celda === "number" && celda > 40000 && celda < 60000) {
    const d = XLSX.SSF.parse_date_code(celda);
    if (d) return d.y * 10000 + d.m * 100 + d.d;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(celda ?? "").trim());
  if (m) {
    let anio = Number(m[3]);
    if (anio < 100) anio += 2000;
    return anio * 10000 + Number(m[2]) * 100 + Number(m[1]);
  }
  return null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[€\s]/g, "").replace(",", "."));
  return isNaN(n) ? null : n;
}

/** Lee el libro y devuelve las filas de vino de la hoja de inventario.
 *  Devuelve null si no reconoce la estructura (cabecera con Bodega/Nombre). */
export function parsearInventario(buffer: Buffer): {
  filas: FilaExcel[];
  etiquetaFecha: string;
} | null {
  const wb = XLSX.read(buffer, { type: "buffer" });

  for (const nombreHoja of wb.SheetNames) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], {
      header: 1,
    });
    if (!rows.length) continue;

    // Buscar la fila de cabecera en las primeras 5 filas
    let iHdr = -1;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const celdas = (rows[i] ?? []).map((c) => normalizar(String(c ?? "")));
      if (celdas.includes("bodega") && celdas.includes("nombre")) {
        iHdr = i;
        break;
      }
    }
    if (iHdr === -1) continue;

    const hdr = rows[iHdr] ?? [];
    const idx = (nombre: string) =>
      hdr.findIndex((h) => normalizar(String(h ?? "")) === nombre);
    const iBodega = idx("bodega");
    const iNombre = idx("nombre");
    const iAnio = hdr.findIndex((h) => ["año", "ano", "añada", "anada"].includes(normalizar(String(h ?? ""))));
    const iTalla = idx("talla");
    const iPV = hdr.findIndex((h) => normalizar(String(h ?? "")).startsWith("preco venta") || normalizar(String(h ?? "")).startsWith("precio venta"));
    const iCompra = hdr.findIndex((h) => normalizar(String(h ?? "")) === "compra");
    const iProv = hdr.findIndex((h) => normalizar(String(h ?? "")) === "proveedor");

    // Columna de stock: la fecha más reciente de la cabecera
    let iStock = -1;
    let mejorFecha = -1;
    let etiquetaFecha = "";
    for (let c = 0; c < hdr.length; c++) {
      const f = fechaDeCabecera(hdr[c]);
      if (f !== null && f > mejorFecha) {
        mejorFecha = f;
        iStock = c;
        const d = String(mejorFecha % 100).padStart(2, "0");
        const m = String(Math.floor(mejorFecha / 100) % 100).padStart(2, "0");
        etiquetaFecha = `${d}/${m}/${Math.floor(mejorFecha / 10000)}`;
      }
    }
    if (iStock === -1) continue;

    const filas: FilaExcel[] = [];
    for (let r = iHdr + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const bodega = row[iBodega];
      const nombre = row[iNombre];
      // Filas de agrupación: nombre numérico o vacío
      if (typeof bodega !== "string" || !bodega.trim()) continue;
      if (typeof nombre !== "string" || !nombre.trim()) continue;
      const anio = num(row[iAnio]);
      const celdaStock = row[iStock];
      const sinCantidad =
        celdaStock === undefined || celdaStock === null || celdaStock === "";
      const prov = iProv >= 0 ? row[iProv] : null;
      filas.push({
        fila: r + 1,
        bodega: bodega.trim(),
        nombre: nombre.trim(),
        anio: anio && anio > 1900 && anio < 2100 ? Math.round(anio) : null,
        talla: iTalla >= 0 && typeof row[iTalla] === "string" && (row[iTalla] as string).trim() ? (row[iTalla] as string).trim() : null,
        stock: Math.max(0, Math.round(num(celdaStock) ?? 0)),
        sinCantidad,
        proveedor: typeof prov === "string" && prov.trim() ? prov.trim() : null,
        precioVenta: iPV >= 0 ? num(row[iPV]) : null,
        precioCompra: iCompra >= 0 ? num(row[iCompra]) : null,
      });
    }
    if (filas.length >= 10) return { filas, etiquetaFecha };
  }
  return null;
}

/** Texto de identidad de una fila para matching (talla incluida: los
 *  magnums son referencias distintas en el catálogo). */
const textoFila = (f: FilaExcel) => `${f.bodega} ${f.nombre} ${f.talla ?? ""}`;
const textoVino = (v: Vino) => `${v.bodega} ${v.nombre}`;

function puntuar(f: FilaExcel, v: Vino): number {
  const tF = tokens(textoFila(f));
  const tV = tokens(textoVino(v));
  if (!tF.size || !tV.size) return 0;
  let comunes = 0;
  for (const t of tF) if (tV.has(t)) comunes++;
  let score = comunes / Math.min(tF.size, tV.size);
  // La talla debe ser coherente: magnum solo casa con magnum
  const esMagF = /magnum/i.test(textoFila(f));
  const esMagV = /magnum/i.test(textoVino(v));
  if (esMagF !== esMagV) score -= 0.5;
  // Cada añada es una referencia distinta (el precio cambia con la cosecha):
  // si ambas están indicadas y difieren, NUNCA emparejar
  if (f.anio !== null && v.anio !== null) {
    if (f.anio !== v.anio) return 0;
    score += 0.15;
  }
  return score;
}

export type Emparejado = { fila: FilaExcel; vino: Vino; score: number };

/** Identidad normalizada: mismo texto y misma añada ⇒ es la misma referencia */
const identidadFila = (f: FilaExcel) =>
  `${normalizar(textoFila(f))}|${f.anio ?? ""}`;
const identidadVino = (v: Vino) => `${normalizar(textoVino(v))}|${v.anio ?? ""}`;

/** Matching 1:1 en dos pases.
 *
 *  1º identidad exacta: una fila cuyo texto y añada coinciden letra a letra
 *     con un vino se casa SIEMPRE con él. Sin este pase, dos filas parecidas
 *     podían empatar a puntos y el greedy asignaba la ficha a la equivocada:
 *     así se crearon los duplicados del 02/08 («Palo blanco» acabó como
 *     referencia nueva porque «Palo Blanco Las molinas» le robó su ficha).
 *  2º greedy por puntuación para todo lo demás.
 *
 *  Además detecta filas repetidas dentro del propio Excel: la segunda vez
 *  que aparece la misma identidad no se convierte en referencia nueva, se
 *  devuelve en `filasRepetidas` para avisar al usuario. */
export function emparejar(
  filas: FilaExcel[],
  vinos: Vino[],
  umbral = 0.75
): {
  emparejados: Emparejado[];
  filasSueltas: FilaExcel[];
  vinosSueltos: Vino[];
  filasRepetidas: FilaExcel[];
} {
  const filaUsada = new Set<number>();
  const vinoUsado = new Set<number>();
  const emparejados: Emparejado[] = [];

  // filas repetidas dentro del excel: solo la primera cuenta
  const vistas = new Map<string, number>();
  const filasRepetidas: FilaExcel[] = [];
  const filasUnicas: FilaExcel[] = [];
  for (const f of filas) {
    const k = identidadFila(f);
    if (vistas.has(k)) {
      filasRepetidas.push(f);
    } else {
      vistas.set(k, f.fila);
      filasUnicas.push(f);
    }
  }

  // 1º pase: identidad exacta
  const porIdentidad = new Map<string, Vino[]>();
  for (const v of vinos) {
    const k = identidadVino(v);
    porIdentidad.set(k, [...(porIdentidad.get(k) ?? []), v]);
  }
  for (const f of filasUnicas) {
    const cands = (porIdentidad.get(identidadFila(f)) ?? []).filter(
      (v) => !vinoUsado.has(v.id)
    );
    if (cands.length) {
      filaUsada.add(f.fila);
      vinoUsado.add(cands[0].id);
      emparejados.push({ fila: f, vino: cands[0], score: 1 });
    }
  }

  // 2º pase: greedy por puntuación
  const candidatos: Emparejado[] = [];
  for (const f of filasUnicas) {
    if (filaUsada.has(f.fila)) continue;
    for (const v of vinos) {
      if (vinoUsado.has(v.id)) continue;
      const score = puntuar(f, v);
      if (score >= umbral) candidatos.push({ fila: f, vino: v, score });
    }
  }
  candidatos.sort((a, b) => b.score - a.score);
  for (const c of candidatos) {
    if (filaUsada.has(c.fila.fila) || vinoUsado.has(c.vino.id)) continue;
    filaUsada.add(c.fila.fila);
    vinoUsado.add(c.vino.id);
    emparejados.push(c);
  }
  return {
    emparejados,
    filasSueltas: filasUnicas.filter((f) => !filaUsada.has(f.fila)),
    vinosSueltos: vinos.filter((v) => !vinoUsado.has(v.id)),
    filasRepetidas,
  };
}

/** Vecino más parecido del catálogo COMPLETO, para avisar de posibles
 *  duplicados antes de crear una referencia nueva. Ignora la exclusividad
 *  del 1:1 (aquí no se asigna nada, solo se avisa). */
export function posibleDuplicado(
  f: FilaExcel,
  vinos: Vino[],
  // bajo a propósito: es solo un aviso y es peor un duplicado que un falso aviso
  umbral = 0.45
): { vino: Vino; score: number } | null {
  let mejor: { vino: Vino; score: number } | null = null;
  for (const v of vinos) {
    const s = puntuar(f, v);
    if (s >= umbral && s > (mejor?.score ?? 0)) mejor = { vino: v, score: s };
  }
  return mejor;
}
