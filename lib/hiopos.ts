// Cliente de la API interna de HioPOS Analytics (la que usa su propio
// cuadro de mando). Pide el informe "Por artículos" de un día concreto.
//
// Descubierta inspeccionando la petición del dashboard:
//   POST /ErpCloud/report/query  ·  cabecera x-auth-token
//   el cuerpo lleva la fecha en filters[0].dateValue y en dateReference

export type ArticuloVendido = {
  codigo: number; // código interno del artículo en el TPV (enlace estable)
  nombre: string;
  unidades: number;
  venta: number;
  documentos: number;
};

/** Columna del informe: solo las cuatro que necesitamos */
function columna(
  posicion: number,
  internalId: number,
  nombre: string,
  opts: { attributeId?: number; metricId?: number; tipo: string; shown: boolean }
) {
  const esMetrica = opts.metricId !== undefined;
  return {
    hasToolTip: false,
    isCount: false,
    axisY: esMetrica ? 1 : 0,
    name: nombre,
    shortName: nombre,
    title: null,
    subtitle: null,
    localizedTitles: {},
    localizedSubtitles: {},
    chartType: null,
    totalType: esMetrica ? "SUM" : "NONE",
    type: opts.tipo,
    columnType: 1,
    sourceType: esMetrica ? "Metric" : "Attribute",
    dashboardFormulas: {},
    detailType: 0,
    destination: "",
    shown: opts.shown,
    metadataHeaderHidden: false,
    sortable: true,
    filterable: true,
    focusable: true,
    mustIncludeAllValues: false,
    draggable: true,
    dropable: true,
    isAttribute: !esMetrica,
    isMetric: esMetrica,
    readOnly: true,
    mask: null,
    parentColumnPosition: null,
    childrenPositions: [],
    width: null,
    mobileRow: null,
    mobileColumn: null,
    mobileWidth: null,
    mobileShowLabel: false,
    dateTablePositionType: 0,
    withinDateRangeFilterType: 0,
    styles: [],
    sortPosition: null,
    metadataSortings: [],
    position: posicion,
    groupId: 0,
    objectCalendarType: 0,
    pivoted: false,
    chartColor: "",
    groupChartId: null,
    groupAttributeId: null,
    serieAttributeId: null,
    isSelector: esMetrica ? false : null,
    existsSelectorColumm: !esMetrica,
    useNegativeStyle: false,
    isSizeColor: false,
    gridPosition: null,
    showBySize: false,
    selectorInputMode: 1,
    qrMode: 0,
    "@type": "BlockColumn",
    internalId,
    ...(esMetrica ? { metricId: opts.metricId } : { attributeId: opts.attributeId }),
    dateFormat: 0,
    textAlign: "center",
    specTypeId: 2,
    modificable: true,
    ...(esMetrica ? {} : { existsPK: true }),
    selector: false,
    navigable: false,
    initialValue: "",
    castToNumberForOrderBy: false,
    blockId: Number(process.env.HIOPOS_BLOCK ?? 9826),
    ...(esMetrica ? {} : { mode: "NONE" }),
    permission: esMetrica ? "Read" : "Write",
  };
}

/** aaaa-mm-dd → cuerpo de la petición para ese día */
function cuerpo(fecha: string, limite: number) {
  const [a, m, d] = fecha.split("-").map(Number);
  const fechaHiopos = `${a}/${m}/${d}`; // el filtro usa 2026/7/31, sin ceros
  return {
    offset: 0,
    limit: limite,
    totals: true,
    rest: false,
    datasources: [{ id: Number(process.env.HIOPOS_DATASOURCE ?? 250) }],
    columns: [
      columna(1, 1, "Cod. Articulo", { attributeId: 109, tipo: "Integer", shown: false }),
      columna(2, 2, "Articulo", { attributeId: 2, tipo: "String", shown: true }),
      columna(6, 4, "Uds.V", { metricId: 1352, tipo: "BigDecimal", shown: true }),
      columna(8, 5, "Venta", { metricId: 1353, tipo: "BigDecimal", shown: true }),
      columna(11, 7, "Docs", { metricId: 1355, tipo: "BigDecimal", shown: true }),
    ],
    ordenableColumns: [],
    filters: [
      {
        permission: false,
        toDelete: false,
        id: -1,
        name: null,
        dateRange: {
          initialScale: 1,
          finalScale: 0,
          toDate: 1,
          numLast: 0,
          numNext: 0,
          numMaxDays: 0,
          scaleOffset: 0,
          comparativeType: 2,
          allowComparativeDates: false,
          displacement: 0,
          displacementScale: 1,
        },
        dateValue: fechaHiopos,
        dateValue2: fechaHiopos,
        filterType: 1,
        profileType: null,
        filterBlocks: [
          {
            id: -1,
            logicOperator: 1,
            negation: false,
            filterGroups: [
              { id: -1, logicOperator: 1, negation: false, filterRows: [], filterBlockId: -1 },
            ],
            filterId: -1,
            filterCardsBlockIdsSelected: [],
          },
        ],
        localizedNames: {},
      },
    ],
    actions: [],
    blocksRefresh: [],
    blockStyles: [],
    blockOperations: [],
    blockBridgeExportations: [],
    blockStyleTypeId: 1,
    elementId: String(Date.now()),
    dashboard: Number(process.env.HIOPOS_DASHBOARD ?? 118),
    block: Number(process.env.HIOPOS_BLOCK ?? 9826),
    linkLocation: null,
    skipCache: false,
    ignoreDates: false,
    id: 3,
    dateReference: fecha,
    columnarCalculation: false,
    refresh: false,
    isDimensionSelector: false,
    calculateSubtotals: false,
    useSizeInColumn: false,
    forceNoResults: false,
    dimensionId: null,
    selectorType: 0,
    useDistinct: false,
    maxResults: null,
  };
}

/** Solo para depurar: expone el cuerpo que se envía */
export const cuerpoDebug = cuerpo;

/** Ventas por artículo de un día. Lanza si el token ha caducado. */
export async function ventasDelDia(
  fecha: string,
  opciones: { token?: string; limite?: number } = {}
): Promise<ArticuloVendido[]> {
  const token = opciones.token ?? process.env.HIOPOS_TOKEN;
  const url = process.env.HIOPOS_URL;
  if (!token || !url) throw new Error("Faltan HIOPOS_TOKEN o HIOPOS_URL");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "x-auth-token": token,
      origin: new URL(url).origin,
      referer: `${new URL(url).origin}/icgfront/analytics`,
    },
    body: JSON.stringify(cuerpo(fecha, opciones.limite ?? 500)),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error("HIOPOS_TOKEN caducado o sin permisos");
  }
  if (!resp.ok) {
    throw new Error(`HioPOS respondió ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const data = await resp.json();
  const filas: unknown[][] = data.rows ?? [];
  // La respuesta trae una cabecera por columna pedida; se localiza cada dato
  // por su attributeId/metricId en vez de asumir posiciones fijas.
  const headers: { attributeId?: number; metricId?: number }[] = data.headers ?? [];
  const idx = (busca: { attributeId?: number; metricId?: number }) =>
    headers.findIndex(
      (h) =>
        h &&
        (busca.attributeId !== undefined
          ? h.attributeId === busca.attributeId
          : h.metricId === busca.metricId)
    );
  const iCod = idx({ attributeId: 109 });
  const iNom = idx({ attributeId: 2 });
  const iUds = idx({ metricId: 1352 });
  const iVen = idx({ metricId: 1353 });
  const iDoc = idx({ metricId: 1355 });
  if (iCod < 0 || iNom < 0 || iUds < 0) {
    throw new Error("La respuesta de HioPOS no trae las columnas esperadas");
  }

  return filas
    .map((f) => ({
      codigo: Number(f[iCod]) || 0,
      nombre: String(f[iNom] ?? "").trim(),
      unidades: Number(f[iUds]) || 0,
      venta: iVen >= 0 ? Number(f[iVen]) || 0 : 0,
      documentos: iDoc >= 0 ? Number(f[iDoc]) || 0 : 0,
    }))
    .filter((a) => a.nombre && a.unidades > 0);
}
