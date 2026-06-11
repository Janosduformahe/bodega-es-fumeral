import type { Vino } from "./types";

export function promptAlbaranCierre(tipo: "albaran" | "cierre", vinos: Vino[]) {
  const catalogo = vinos
    .map((w) => `ID:${w.id} | ${w.bodega} | ${w.nombre} | ${w.anio ?? "NV"}`)
    .join("\n");
  const docTypeLabel =
    tipo === "albaran"
      ? "albarán de proveedor (entrada de stock)"
      : "cierre de caja TPV (ventas del día)";

  return `Eres un asistente de gestión de bodega de restaurante. Te voy a pasar un ${docTypeLabel}.

Tu tarea:
1. Leer el documento e identificar cada vino o referencia con su cantidad de botellas.
2. Para cada vino encontrado, buscar el ID correspondiente en el catálogo de la bodega (abajo).
3. Devolver SOLO un JSON válido, sin texto adicional, sin markdown, con este formato exacto:

{
  "proveedor_o_fecha": "nombre del proveedor o fecha del cierre",
  "items": [
    {"id": 5, "qty": 6, "texto_original": "texto tal como aparece en el doc", "confianza": "alta|media|baja"}
  ],${
    tipo === "albaran"
      ? `
  "nuevas_referencias": [
    {"anio": 2019, "bodega": "Nombre de la bodega/productor", "nombre": "Nombre del vino", "tipo": "Tinto", "pais": "Francia", "uva": "Cabernet Sauvignon", "precio": 0, "stock": 2, "texto_original": "texto tal como aparece en el doc"}
  ],`
      : ""
  }
  "no_encontrados": [
    {"texto": "descripción del vino no identificado", "qty": 2}
  ]
}

CATÁLOGO DE LA BODEGA:
${catalogo}

INSTRUCCIONES:
- Para ${tipo === "albaran" ? "albaranes" : "cierres de caja"}, la cantidad es el número de botellas ${tipo === "albaran" ? "recibidas" : "vendidas"}.
- Usa coincidencia aproximada de nombres (puede haber variaciones ortográficas, abreviaciones).
${
  tipo === "albaran"
    ? `- Si un vino del albarán NO existe en el catálogo pero puedes identificarlo con claridad (bodega + nombre legibles), ponlo en "nuevas_referencias" como alta nueva: separa bodega/productor y nombre del vino, deduce "tipo" (uno de: Espumoso, Blanco, Rosado, Tinto, Dulce), "pais" y "uva" usando tu conocimiento de vinos; "anio" es número o null; "stock" = botellas recibidas. "precio" = 0 (el albarán trae precio de coste, no PVP — el precio de venta lo pondrá el equipo).
- Usa "no_encontrados" solo para líneas ilegibles o que no puedas identificar con confianza.`
    : `- Si no estás seguro del ID, usa confianza "baja" o ponlo en no_encontrados.`
}
- Devuelve SOLO el JSON, nada más.`;
}

export function promptExcel(csv: string, vinos: Vino[]) {
  const catalogo = vinos
    .map(
      (w) =>
        `ID:${w.id}|${w.anio ?? "NV"}|${w.bodega}|${w.nombre}|stock:${w.stock}|precio:${w.precio}`
    )
    .join("\n");

  return `Eres un asistente de gestión de bodega de restaurante. Te adjunto el contenido (en CSV) del Excel de inventario actualizado.

El archivo tiene estas columnas aproximadas: Año, Bodega, Nombre, Talla, Proveedor, Inventario Final, Valor Final, Compra, Compra+IVA, Precio Venta, y columnas de stock con fechas (la última columna de stock es la más reciente — úsala como stock actual).

Tu tarea: comparar cada fila del Excel con el catálogo actual de la bodega y devolver SOLO un JSON con este formato exacto (sin markdown, sin texto adicional):

{
  "actualizaciones": [
    {"id": 5, "stock_nuevo": 12, "precio_nuevo": 130}
  ],
  "nuevas_referencias": [
    {"anio": 2023, "bodega": "Nombre bodega", "nombre": "Nombre vino", "tipo": "Tinto", "pais": "España", "uva": "Tempranillo", "precio": 85, "stock": 6}
  ],
  "no_identificados": [
    {"texto": "descripción del vino que no se pudo identificar"}
  ]
}

REGLAS:
- Para "actualizaciones": busca coincidencia aproximada entre filas del Excel y el catálogo (puede haber variaciones ortográficas). Usa el ID del catálogo.
- El stock a usar es el de la ÚLTIMA columna de fecha (la más reciente del Excel).
- Para "precio_nuevo": usa la columna "Precio Venta" si está disponible; si no, pon el precio actual.
- Para "nuevas_referencias": incluye solo vinos que NO existan en el catálogo actual. "anio" es un número o null.
- "tipo" debe ser uno de: Espumoso, Blanco, Rosado, Tinto, Dulce.
- Devuelve SOLO el JSON válido, sin texto extra.

CATÁLOGO ACTUAL:
${catalogo}

CONTENIDO DEL EXCEL (CSV):
${csv}`;
}
