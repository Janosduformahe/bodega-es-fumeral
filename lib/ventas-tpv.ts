// Casado de las ventas del TPV (por API o por informe subido) con el catálogo.
// Compartido por /api/documentos y por la sincronización automática.
import { emparejarCarta } from "./carta";
import type { ResultadoDocumento, Vino } from "./types";

export type LineaVenta = {
  texto: string;
  unidades: number;
  /** código interno del artículo en el TPV, si se conoce (enlace estable) */
  codigo?: number | null;
  /** facturación total de esa línea, para deducir el precio unitario */
  importe?: number | null;
};

/** Ventas por copa: no descuentan una botella entera del inventario */
export const ES_COPA = /\bcopas?\b|\bby the glass\b|\bcata\b/i;

/** Muchas copas no llevan "COPA" en el nombre. Señal fiable: el precio
 *  unitario cobrado es muy inferior al precio de botella de la carta.
 *  Verificado con un año de ventas: las botellas reales se cobran al
 *  83-101% del PVP, mientras que las copas rondan el 8-25%. */
const UMBRAL_COPA = 0.5;
function pareceCopa(linea: LineaVenta, precioBotella: number): boolean {
  if (!linea.importe || linea.unidades <= 0 || precioBotella <= 0) return false;
  const unitario = linea.importe / linea.unidades;
  return unitario / precioBotella < UMBRAL_COPA;
}

const UMBRAL_AUTO = 0.8;
const UMBRAL_SUGERENCIA = 0.55;

export type AliasLookup = Map<string, number>;

export function casarVentas(
  lineas: LineaVenta[],
  vinos: Vino[],
  alias: AliasLookup,
  etiquetaOrigen: string
): ResultadoDocumento {
  const resultado: ResultadoDocumento = {
    proveedor_o_fecha: etiquetaOrigen,
    movimientos: [],
    precios: [],
    nuevas_referencias: [],
    no_encontrados: [],
    bajas_sugeridas: [],
    carta_sugerencias: [],
    tpv_items: [],
    preview: [],
  };
  const porId = new Map(vinos.map((v) => [v.id, v]));

  // Las copas se informan pero nunca descuentan botellas
  const copas = lineas.filter((l) => ES_COPA.test(l.texto));
  const botellas = lineas.filter((l) => !ES_COPA.test(l.texto));
  for (const c of copas) {
    resultado.no_encontrados!.push({
      texto: `${c.unidades} × "${c.texto}" — venta por copa, no descuenta botella`,
      qty: c.unidades,
    });
  }

  // 1) Nombres ya confirmados antes (o código del TPV ya mapeado)
  const pendientes: LineaVenta[] = [];
  const usados = new Set<number>();
  for (const l of botellas) {
    const porCodigo = l.codigo ? alias.get(`tpv:${l.codigo}`) : undefined;
    const porTexto = alias.get(l.texto.toLowerCase().trim());
    const id = porCodigo ?? porTexto;
    if (id && porId.has(id) && !usados.has(id)) {
      usados.add(id);
      resultado.tpv_items!.push({ vino_id: id, qty: -l.unidades, texto: l.texto });
    } else {
      pendientes.push(l);
    }
  }

  // 2) Casado determinista en modo estricto (la mayoría de líneas es comida)
  const libres = vinos.filter((v) => !usados.has(v.id));
  const { casados, sinCasar } = emparejarCarta(
    pendientes.map((l) => ({ texto: l.texto })),
    libres,
    UMBRAL_SUGERENCIA,
    true
  );
  const udsDe = (texto: string) =>
    pendientes.find((p) => p.texto === texto)?.unidades ?? 0;

  const lineaDe = (texto: string) => pendientes.find((p) => p.texto === texto);

  for (const c of casados) {
    const qty = udsDe(c.linea.texto);
    const original = lineaDe(c.linea.texto);
    // Copa encubierta: mismo vino, pero cobrado a precio de copa
    if (original && pareceCopa(original, Number(c.vino.precio) || 0)) {
      const unit = (original.importe ?? 0) / Math.max(1, original.unidades);
      resultado.no_encontrados!.push({
        texto: `${qty} × "${c.linea.texto}" a ${unit.toFixed(1)} € (botella ${c.vino.precio} €) — parece venta por copa, no se descuenta`,
        qty,
      });
      continue;
    }
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

  resultado.carta_sin_casar = sinCasar.map((l) => ({
    texto: l.texto,
    precio: null,
    qty: udsDe(l.texto),
  }));

  for (const it of resultado.tpv_items!) {
    const w = porId.get(it.vino_id)!;
    resultado.preview!.push({
      vino_id: w.id,
      etiqueta: `${w.bodega} — ${w.nombre}${w.anio ? ` (${w.anio})` : ""}`,
      detalle: `"${it.texto}" · quedarían ${Math.max(0, w.stock + it.qty)} de ${w.stock}`,
      qty: `−${Math.abs(it.qty)}`,
      direccion: "minus",
    });
  }
  return resultado;
}
