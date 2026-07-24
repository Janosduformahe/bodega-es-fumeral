export type TipoVino = "Espumoso" | "Blanco" | "Rosado" | "Tinto" | "Dulce";
export type TipoMovimiento = "venta" | "entrada" | "excel" | "ajuste";
export type TipoDocumento = "albaran" | "cierre" | "excel" | "carta";

export type Vino = {
  id: number;
  anio: number | null;
  bodega: string;
  nombre: string;
  tipo: TipoVino;
  pais: string;
  uva: string | null;
  precio: number;
  precio_compra: number | null;
  proveedor: string | null;
  stock: number;
  activo: boolean;
  en_carta: boolean;
  carta_actualizada: string | null;
};

export type Movimiento = {
  id: number;
  vino_id: number;
  tipo: TipoMovimiento;
  qty: number;
  stock_prev: number;
  stock_nuevo: number;
  nota: string | null;
  created_at: string;
};

export type DocumentoRow = {
  id: number;
  tipo: TipoDocumento;
  nombre_archivo: string;
  modelo_ia: string | null;
  resultado: ResultadoDocumento | null;
  aplicado: boolean;
  created_at: string;
};

/** Forma normalizada que guarda /api/documentos en documentos.resultado
 *  y que consume la RPC aplicar_documento. */
export type ResultadoDocumento = {
  proveedor_o_fecha?: string;
  movimientos: { vino_id: number; qty: number; nota?: string }[];
  /** Actualizaciones de ficha (precio de venta, coste, proveedor) */
  precios?: {
    vino_id: number;
    precio_nuevo?: number;
    precio_compra_nuevo?: number;
    proveedor_nuevo?: string;
  }[];
  /** Documentos de tipo carta: ids que quedan EN carta (el resto, fuera) */
  carta_ids?: number[];
  /** Referencias que el inventario sugiere retirar del catálogo */
  bajas_sugeridas?: {
    vino_id: number;
    etiqueta: string;
    motivo: "sin_cantidad" | "no_en_excel";
    stock: number;
  }[];
  nuevas_referencias?: {
    anio: number | null;
    bodega: string;
    nombre: string;
    tipo: TipoVino;
    pais: string;
    uva: string | null;
    precio: number;
    precio_compra?: number | null;
    proveedor?: string | null;
    stock: number;
  }[];
  no_encontrados?: { texto: string; qty?: number }[];
  /** datos solo para previsualización en UI */
  preview?: {
    vino_id: number;
    etiqueta: string;
    detalle: string;
    qty: string;
    direccion: "plus" | "minus";
    confianza?: string;
  }[];
};

export function nombreVino(v: { bodega: string; nombre: string; anio: number | null }) {
  return `${v.bodega} — ${v.nombre}${v.anio ? ` (${v.anio})` : ""}`;
}

export function fmtFecha(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("es-ES") +
    " " +
    d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
  );
}
