import type { Vino } from "./types";

/** Extracción PURA de un albarán: sin catálogo. El casado con el inventario
 *  se hace después en código, igual que en la carta y el TPV. La IA casando
 *  contra 600 referencias fallaba: devolvía albaranes vacíos. */
export function promptExtraerAlbaran() {
  return `Eres un asistente que transcribe albaranes y facturas de proveedores de vino de restaurante.

Te paso un albarán o factura (foto o PDF), en español o inglés ("delivery note"). Transcribe TODAS las líneas de producto, sin saltarte ninguna.

Devuelve SOLO un JSON válido, sin markdown:

{"proveedor":"nombre del proveedor tal como figura","lineas":[{"texto":"línea tal cual aparece","bodega":"productor","nombre":"nombre del vino","anio":2019,"unidades":6,"precio_compra":24.5,"tipo":"Tinto","pais":"Francia","uva":"Merlot"}]}

REGLAS:
- "texto": la línea literal del documento (sirve para revisar después).
- "bodega"/"nombre": sepáralos usando tu conocimiento de vinos (ej.: "Alter Ego Palmer" → bodega "Château Palmer", nombre "Alter Ego"). Si no está claro, deja bodega en null y pon todo en nombre.
- "anio": añada si figura; null si no aparece o pone NV.
- "unidades": botellas de la línea. Si el albarán va en cajas, multiplica (1 caja = 6 o 12 según indique).
- "precio_compra": precio unitario SIN IVA si está desglosado; null si el documento no trae precios.
- "tipo" (Espumoso, Blanco, Rosado, Tinto o Dulce), "pais" y "uva": dedúcelos con tu conocimiento del vino; null si no lo sabes.
- NO incluyas portes, depósitos, envases, descuentos ni líneas que no sean bebida.
- No inventes líneas: transcribe únicamente lo que ves.`;
}

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
    {"anio": 2019, "bodega": "Nombre de la bodega/productor", "nombre": "Nombre del vino", "tipo": "Tinto", "pais": "Francia", "uva": "Cabernet Sauvignon", "precio": 0, "precio_compra": 24.5, "stock": 2, "texto_original": "texto tal como aparece en el doc"}
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
    ? `- Si un vino del albarán NO existe en el catálogo pero puedes identificarlo con claridad (bodega + nombre legibles), ponlo en "nuevas_referencias" como alta nueva: separa bodega/productor y nombre del vino, deduce "tipo" (uno de: Espumoso, Blanco, Rosado, Tinto, Dulce), "pais" y "uva" usando tu conocimiento de vinos; "anio" es número o null; "stock" = botellas recibidas. "precio" = 0 y "precio_compra" = el precio unitario de coste que figure en el albarán (sin IVA si está desglosado; null si no se ve).
- Usa "no_encontrados" solo para líneas ilegibles o que no puedas identificar con confianza.`
    : `- Si no estás seguro del ID, usa confianza "baja" o ponlo en no_encontrados.`
}
- Devuelve SOLO el JSON, nada más.`;
}

export function promptExcel(csv: string, vinos: Vino[], columnaStock?: string | null) {
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
    {"anio": 2023, "bodega": "Nombre bodega", "nombre": "Nombre vino", "tipo": "Tinto", "pais": "España", "uva": "Tempranillo", "precio": 85, "precio_compra": 24.5, "stock": 6}
  ],
  "no_identificados": [
    {"texto": "descripción del vino que no se pudo identificar"}
  ]
}

REGLAS:
- El catálogo de abajo ya incluye el stock y el precio ACTUALES de cada vino. En "actualizaciones" incluye SOLO los vinos cuyo stock o precio CAMBIAN respecto al catálogo — omite por completo los que quedan igual.
- Para "actualizaciones": busca coincidencia aproximada entre filas del Excel y el catálogo (puede haber variaciones ortográficas). Usa el ID del catálogo.
${
  columnaStock
    ? `- IMPORTANTE: el stock actual es el de la columna "${columnaStock}" EXACTAMENTE (es la columna de fecha más reciente del archivo). IGNORA cualquier otra columna de fecha y la columna "INVENTARIO FINAL".`
    : `- El stock a usar es el de la ÚLTIMA columna de fecha (la más reciente del Excel).`
}
- Para "precio_nuevo": usa la columna "Precio Venta" si está disponible; si el precio no cambia, omite el campo.
- Para "nuevas_referencias": incluye solo vinos que NO existan en el catálogo actual. "anio" es un número o null. "precio" = columna "Precio Venta" si existe (0 si no); "precio_compra" = columna "Compra" si existe (null si no).
- Ignora filas de agrupación/sección del Excel (nombres de país o tipo sueltos con contadores) — no son vinos.
- "tipo" debe ser uno de: Espumoso, Blanco, Rosado, Tinto, Dulce.
- Devuelve SOLO el JSON válido, COMPACTO EN UNA SOLA LÍNEA (sin saltos de línea ni espacios de indentación), sin texto extra.

CATÁLOGO ACTUAL:
${catalogo}

CONTENIDO DEL EXCEL (CSV):
${csv}`;
}
