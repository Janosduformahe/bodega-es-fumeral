export type TipoVino = "Espumoso" | "Blanco" | "Rosado" | "Tinto" | "Dulce";
export type TipoMovimiento = "venta" | "entrada" | "excel" | "ajuste" | "merma";
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
  /** Ruta del fichero original en Storage (los cierres del cron no tienen) */
  storage_path?: string | null;
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
  /** Documentos de tipo carta: ids casados con certeza (el resto, fuera) */
  carta_ids?: number[];
  /** Líneas con un candidato probable, a confirmar por el equipo
   *  (carta y cierres de caja del TPV) */
  carta_sugerencias?: {
    texto: string;
    vino_id: number;
    etiqueta: string;
    score: number;
    precio: number | null;
    /** cierres de caja: unidades vendidas de esa línea */
    qty?: number;
  }[];
  /** Líneas sin candidato: se resuelven buscando a mano */
  carta_sin_casar?: {
    texto: string;
    precio: number | null;
    nota?: string;
    qty?: number;
  }[];
  /** Cierres de TPV: movimientos casados con certeza, con su texto de origen */
  tpv_items?: { vino_id: number; qty: number; texto: string }[];
  /** Aviso de que este albarán parece una re-subida de otro reciente */
  aviso_duplicado?: string;
  /** Detalle de lo casado automáticamente (para aplicar precios y alias) */
  carta_items?: { vino_id: number; precio: number | null; texto: string }[];
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
