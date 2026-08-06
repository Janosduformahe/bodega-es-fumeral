// Casado de las ventas del TPV (por API o por informe subido) con el catálogo.
// Compartido por /api/documentos y por la sincronización automática.
import { emparejarCarta, puntuar } from "./carta";
import type { ResultadoDocumento, Vino } from "./types";

/** Una botella da para ~5 copas: las ventas por copa descuentan la parte
 *  proporcional, redondeada a botellas enteras (el stock es entero). */
export const COPAS_POR_BOTELLA = 5;

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

/** Artículos del TPV que claramente NO son vino (cafés, aguas, cócteles,
 *  cervezas, postres…). Sólo se usa para no enseñarlos en la revisión del
 *  cierre: el que revisa quiere ver vinos, no la carta de cafés. Si algo se
 *  filtra de más, el botón «ver todo» de la revisión lo enseña igualmente. */
export const ES_OTRO_ARTICULO =
  /\b(cafes?|café|capp?uc+ino|cortado|espresso|descafeinado|latte|te|té|infusi[oó]n(es)?|manzanilla|poleo|rooibos|earl grey|aguas?|badoit|evian|vichy|t[oó]nicas?|cola|fanta|sprite|aquarius|refrescos?|zumos?|nestea|red\s?bull|cervezas?|caña|jarra|heineken|estrella|mahou|alhambra|corona|damm|ipa|lager|gin|ginebra|vodka|whisky|whiskey|bourbon|tequila|mezcal|licor|orujo|baileys|vermut|vermouth|campari|aperol|spritz|mojito|margarita|daiquiri|negroni|martini|caipirinha|paloma|penicillin|old fashioned|espresso martini|c[oó]ctel|cocktail|chupito|combinado|sangr[íi]a|tinto de verano|rebujito|postres?|helados?|sorbete|tartas?|coulant|cheesecake|baba|brownie|flan|fruta|menú|menu|cubiertos?|servicio|pan)\b/i;

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

  /** Copas → botellas equivalentes. Devuelve true si la línea queda resuelta. */
  const descontarCopas = (l: LineaVenta, vino: Vino | null): boolean => {
    if (!vino) return false;
    const bot = Math.round(l.unidades / COPAS_POR_BOTELLA);
    if (bot >= 1) {
      resultado.tpv_items!.push({
        vino_id: vino.id,
        qty: -bot,
        texto: `${l.texto} (${l.unidades} copas ≈ ${bot} bot.)`,
      });
    } else {
      resultado.no_encontrados!.push({
        texto: `${l.unidades} × "${l.texto}" — menos de ${COPAS_POR_BOTELLA} copas, no llega a una botella`,
        qty: l.unidades,
      });
    }
    return true;
  };

  /** Mejor vino para una línea de copa: primero el alias aprendido, luego el
   *  texto sin la palabra "copa". Sin exclusividad 1:1 — el mismo vino puede
   *  venderse por botella Y por copa el mismo día. */
  const vinoDeCopa = (l: LineaVenta): Vino | null => {
    const porAlias = alias.get(l.texto.toLowerCase().trim());
    if (porAlias && porId.has(porAlias)) return porId.get(porAlias)!;
    const texto = l.texto.replace(ES_COPA, " ").replace(/\s+/g, " ").trim();
    if (!texto) return null;
    let mejor: { s: number; v: Vino | null } = { s: 0, v: null };
    for (const v of vinos) {
      const s = puntuar({ texto }, v, false, true);
      if (s > mejor.s) mejor = { s, v };
    }
    return mejor.s >= 0.55 ? mejor.v : null;
  };

  // Las copas descuentan la parte proporcional de botella
  const copas = lineas.filter((l) => ES_COPA.test(l.texto));
  const botellas = lineas.filter((l) => !ES_COPA.test(l.texto));
  for (const c of copas) {
    if (!descontarCopas(c, vinoDeCopa(c))) {
      resultado.no_encontrados!.push({
        texto: `${c.unidades} × "${c.texto}" — venta por copa sin vino identificado`,
        qty: c.unidades,
      });
    }
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
    // Copa encubierta: mismo vino, pero cobrado a precio de copa.
    // Descuenta su parte proporcional de botella.
    if (original && pareceCopa(original, Number(c.vino.precio) || 0)) {
      descontarCopas(original, c.vino);
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
