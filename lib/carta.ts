// Emparejado de las líneas de la carta de vinos con el catálogo.
// La IA solo EXTRAE las líneas del documento; el casado se hace en código,
// que es exhaustivo por construcción (no se salta líneas como hacía la IA).
import type { Vino } from "./types";

export type LineaCarta = {
  texto: string;
  bodega?: string | null;
  nombre?: string | null;
  anio?: number | null;
  precio?: number | null;
};

/** minúsculas, sin acentos ni puntuación, con las variantes típicas de carta
 *  unificadas ("1 er cru" → "1er cru", "Chassagne-Mont." → "chassagne mont") */
export function normalizar(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/''+/g, "'") // el TPV duplica las comillas: L''Abbaye → L'Abbaye
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\b1\s*(er|ere|o|º)\b/g, "1er")
    .replace(/\bpremier\b/g, "1er")
    .replace(/\bgrand\s+cru\b/g, "grandcru")
    .replace(/\s+/g, " ")
    .trim();
}

const RUIDO = new Set([
  "de", "la", "el", "les", "los", "las", "du", "des", "le", "the", "and", "y",
  "et", "vins", "vin", "wines", "wine", "domaine", "dom", "bodega", "bodegas",
  "chateau", "ch", "fils", "fille", "filles", "freres", "hermanos", "sa", "sl",
  "cru", "vino", "vinos", "cl", "ml",
]);

export function tokens(s: string): string[] {
  return normalizar(s)
    .split(" ")
    .filter((t) => t.length >= 2 && !RUIDO.has(t));
}

/** ¿Dos tokens son el mismo concepto? Admite abreviaturas de carta
 *  ("mont" ↔ "montrachet", "chambolle" ↔ "chambolle") */
function tokenIgual(a: string, b: string): boolean {
  if (a === b) return true;
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  return corto.length >= 4 && largo.startsWith(corto);
}

function comunes(tsA: string[], tsB: string[], soloExacto = false): number {
  const usados = new Set<number>();
  let n = 0;
  for (const a of tsA) {
    for (let i = 0; i < tsB.length; i++) {
      if (usados.has(i)) continue;
      const igual = soloExacto ? a === tsB[i] : tokenIgual(a, tsB[i]);
      if (igual) {
        usados.add(i);
        n++;
        break;
      }
    }
  }
  return n;
}

function solape(tsA: string[], tsB: string[]): number {
  if (!tsA.length || !tsB.length) return 0;
  return comunes(tsA, tsB) / Math.min(tsA.length, tsB.length);
}

const esMagnum = (s: string) =>
  /\bmagnum\b|\b1\s*[,.]?\s*5\s*l\b|\b150\s*cl\b/i.test(s);

/** Puntuación 0..1 de que la línea sea ese vino del catálogo.
 *  - `ignorarAnio`: para detectar "mismo vino, otra añada".
 *  - `estricto`: para orígenes donde la mayoría de líneas NO son vino
 *    (informe de ventas del TPV, lleno de comida y bebidas). Exige
 *    coincidencia exacta en líneas de una sola palabra, que si no
 *    casarían por prefijo ("CAÑA" con "Croix-Canat"). En la carta no
 *    hace falta: allí toda línea es un vino. */
export function puntuar(
  linea: LineaCarta,
  v: Vino,
  ignorarAnio = false,
  estricto = false
): number {
  const textoLinea = [linea.bodega, linea.nombre, linea.texto]
    .filter(Boolean)
    .join(" ");
  const textoVino = `${v.bodega} ${v.nombre}`;

  // Cada añada es una referencia distinta: si ambas constan y difieren, no casa
  const anioLinea = linea.anio ?? null;
  if (!ignorarAnio && anioLinea !== null && v.anio !== null && anioLinea !== v.anio)
    return 0;

  // El formato magnum es otra referencia
  if (esMagnum(textoLinea) !== esMagnum(textoVino)) return 0;

  const tsL = tokens(textoLinea);
  const tsV = tokens(textoVino);
  if (!tsL.length || !tsV.length) return 0;

  const n = comunes(tsL, tsV, estricto && tsL.length === 1);
  if (!n) return 0;

  // Dos factores: el solape "min" premia que uno contenga al otro
  // (la carta y el TPV abrevian), y la cobertura de la línea evita que un
  // vino genérico del catálogo gane a la parcela concreta que sí se nombra
  // ("Chambolle-Musigny" vs "…1er Cru Les Feusselottes").
  const solapeMin = n / Math.min(tsL.length, tsV.length);
  const cobLinea = n / tsL.length;
  let score = 0.75 * solapeMin + 0.25 * cobLinea;

  // Refuerzo si la bodega coincide por separado (la carta suele empezar por ella)
  if (linea.bodega) {
    const sb = solape(tokens(linea.bodega), tokens(v.bodega));
    if (sb >= 0.8) score += 0.12;
  }
  // Refuerzo si el nombre del vino coincide bien
  if (linea.nombre) {
    const sn = solape(tokens(linea.nombre), tokens(v.nombre));
    if (sn >= 0.8) score += 0.12;
  }
  if (!ignorarAnio && anioLinea !== null && v.anio !== null && anioLinea === v.anio)
    score += 0.08;

  return Math.min(1, score);
}

/** ¿La línea es un vino que sí está en el catálogo pero con otra añada? */
export function mismaReferenciaOtraAnada(
  linea: LineaCarta,
  vinos: Vino[]
): Vino | null {
  if (linea.anio === null || linea.anio === undefined) return null;
  let mejor: { score: number; vino: Vino | null } = { score: 0, vino: null };
  for (const v of vinos) {
    if (v.anio === null || v.anio === linea.anio) continue;
    const s = puntuar(linea, v, true);
    if (s > mejor.score) mejor = { score: s, vino: v };
  }
  return mejor.score >= 0.8 ? mejor.vino : null;
}

export type Casado = { linea: LineaCarta; vino: Vino; score: number };

/** Emparejado 1:1 greedy por puntuación descendente */
export function emparejarCarta(
  lineas: LineaCarta[],
  vinos: Vino[],
  umbral = 0.72,
  estricto = false
): { casados: Casado[]; sinCasar: LineaCarta[] } {
  const candidatos: Casado[] = [];
  for (const linea of lineas) {
    for (const vino of vinos) {
      const score = puntuar(linea, vino, false, estricto);
      if (score >= umbral) candidatos.push({ linea, vino, score });
    }
  }
  candidatos.sort((a, b) => b.score - a.score);
  const lineaUsada = new Set<string>();
  const vinoUsado = new Set<number>();
  const casados: Casado[] = [];
  for (const c of candidatos) {
    if (lineaUsada.has(c.linea.texto) || vinoUsado.has(c.vino.id)) continue;
    lineaUsada.add(c.linea.texto);
    vinoUsado.add(c.vino.id);
    casados.push(c);
  }
  return {
    casados,
    sinCasar: lineas.filter((l) => !lineaUsada.has(l.texto)),
  };
}

/** Prompt de EXTRACCIÓN pura: sin catálogo, la IA solo transcribe la carta */
export function promptExtraerCarta() {
  return `Eres un asistente que transcribe cartas de vinos de restaurante.

Te paso la CARTA DE VINOS completa (PDF, foto o varias páginas). Transcribe TODAS las líneas de vino, de principio a fin, sin saltarte ninguna sección ni página.

Devuelve SOLO un JSON válido, COMPACTO EN UNA SOLA LÍNEA, sin markdown:

{"lineas":[{"texto":"línea tal cual aparece","bodega":"productor","nombre":"nombre del vino","anio":2019,"precio":85}]}

REGLAS:
- "texto": la línea literal de la carta (sirve para revisar después).
- "bodega" y "nombre": sepáralos lo mejor que puedas. Si no está claro, deja "bodega" en null y pon todo en "nombre".
- "anio": número de añada si figura; null si no aparece o pone NV/S.A.
- "precio": número sin símbolo; null si no hay.
- Si la línea indica formato (Magnum, 150cl, 1,5L), déjalo dentro de "texto" y de "nombre".
- NO incluyas: encabezados de sección (regiones, tipos), textos de maridaje, notas de cata, ni precios por copa sin vino.
- No inventes vinos ni añadas: transcribe únicamente lo que ves.`;
}
