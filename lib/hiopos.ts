// Cliente de la API interna de HioPOS Analytics (la que usa su propio
// cuadro de mando). Pide el informe "Por artículos" de un día concreto.
//
// Descubierta inspeccionando la petición del dashboard:
//   POST /ErpCloud/report/query  ·  cabecera x-auth-token
//   el cuerpo lleva la fecha en filters[0].dateValue y en dateReference

import crypto from "crypto";

/** Cifrado que usa su propio front antes de enviar las credenciales:
 *  AES-128-CBC con clave e IV fijos, base64, y después sustituyen los dos
 *  caracteres que dan problemas en una URL por marcadores propios. */
const CLAVE_HIOPOS = "B1B2B3B4B5B6B7B8";
function cifrar(texto: string): string {
  const c = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(CLAVE_HIOPOS),
    Buffer.from(CLAVE_HIOPOS)
  );
  const b64 = Buffer.concat([c.update(texto, "utf8"), c.final()]).toString("base64");
  return b64.replace(/\//g, "-999999-").replace(/\+/g, "-666666-");
}

/** Datos de la instancia analítica del cliente (orígenes de datos, tipo…) */
async function datosCliente(customerId: string) {
  const r = await fetch(
    `https://cloudlicense03.hiopos.com/services/cloud/getCustomerAnalyticsDB?customerId=${customerId}`,
    { headers: { "Content-Type": "text/xml" } }
  );
  const xml = await r.text();
  const tag = (t: string) => {
    const a = xml.indexOf(`<${t}>`);
    return a === -1 ? "" : xml.slice(a + t.length + 2, xml.indexOf(`</${t}>`, a));
  };
  const spec = tag("specType");
  return {
    ipWS: tag("ipAddress"),
    portWS: tag("port") || "1",
    dbName: tag("dbName"),
    specType: spec === "HioPos" ? "2" : spec === "FrontRest" ? "3" : "1",
    datasourceList: [...xml.matchAll(/<datasourceList>(\d+)<\/datasourceList>/g)]
      .map((m) => m[1])
      .join(","),
    marginCost: String(xml.includes("<groupList>8</groupList>")),
    freeFields: String(xml.includes("<groupList>11</groupList>")),
  };
}

/** Inicia sesión y devuelve un x-auth-token nuevo.
 *  GET /ErpCloud/session/login — el token viene en la cabecera de respuesta.
 *  Después hay que inicializar la sesión (ver `abrirSesion`). */
export async function login(): Promise<string> {
  const user = process.env.HIOPOS_USER;
  const password = process.env.HIOPOS_PASSWORD;
  const customerId = process.env.HIOPOS_CUSTOMER;
  const host = process.env.HIOPOS_HOST;
  if (!user || !password || !customerId || !host) {
    throw new Error("Faltan HIOPOS_USER, HIOPOS_PASSWORD, HIOPOS_CUSTOMER o HIOPOS_HOST");
  }

  const c = await datosCliente(customerId);
  const hoy = new Date();
  const workDate = `'${hoy.getFullYear()}/${String(hoy.getMonth() + 1).padStart(2, "0")}/${String(hoy.getDate()).padStart(2, "0")}'`;

  // Se construye a mano: los marcadores -999999- no deben re-codificarse
  const q = [
    `user=${cifrar(user)}`,
    `password=${cifrar(password)}`,
    `customerId=${customerId}`,
    `languageIsoCode=es`,
    `specType=${c.specType}`,
    `ipWS=${cifrar(c.ipWS)}`,
    `portWS=${cifrar(c.portWS)}`,
    `dbName=${cifrar(c.dbName)}`,
    `workDate=${encodeURIComponent(workDate)}`,
    `datasourceList=${c.datasourceList}`,
    `marginCost=${c.marginCost}`,
    `isDocs=false`,
    `isCloudDocs=false`,
    `isAnalytics=true`,
    `budget=true`,
    `freeFields=${c.freeFields}`,
    `encrypted=true`,
  ].join("&");

  const r = await fetch(`${host}/ErpCloud/session/login?${q}`, {
    headers: { "Content-Type": "application/json" },
  });
  const token = r.headers.get("x-auth-token");
  if (!r.ok || !token) {
    throw new Error(`Login de HioPOS falló (${r.status}): ${(await r.text()).slice(0, 150)}`);
  }
  return token;
}

/** Secuencia de arranque que hace el propio panel tras entrar: sin esto la
 *  sesión existe pero no tiene contexto de empresa y los informes dan 500. */
export async function abrirSesion(token: string): Promise<void> {
  const host = process.env.HIOPOS_HOST!;
  const cab = {
    "x-auth-token": token,
    accept: "application/json, text/plain, */*",
    referer: `${host}/icgfront/analytics`,
  };
  const pasos = [
    "/ErpCloud/report/isIcgUser/",
    "/ErpCloud/report/setSessionRegionalConfiguration",
    "/ErpCloud/report/getUser?mobileMode=false",
    "/ErpCloud/entityLoader/company",
    "/ErpCloud/report/getSessionConstants",
  ];
  for (const p of pasos) {
    await fetch(`${host}${p}`, { headers: cab }).catch(() => null);
  }
}

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

/** aaaa-mm-dd → cuerpo de la petición. Con `hasta` pide un rango. */
function cuerpo(fecha: string, limite: number, hasta?: string) {
  const fmt = (f: string) => {
    const [a, m, d] = f.split("-").map(Number);
    return `${a}/${m}/${d}`; // el filtro usa 2026/7/31, sin ceros
  };
  const fechaHiopos = fmt(fecha);
  const fechaHiopos2 = hasta ? fmt(hasta) : fechaHiopos;
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
        dateValue2: fechaHiopos2,
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

async function pedirInforme(
  fecha: string,
  token: string,
  limite: number,
  hasta?: string
) {
  const url = process.env.HIOPOS_URL;
  if (!url) throw new Error("Falta HIOPOS_URL");
  return fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      "x-auth-token": token,
      origin: new URL(url).origin,
      referer: `${new URL(url).origin}/icgfront/analytics`,
    },
    body: JSON.stringify(cuerpo(fecha, limite, hasta)),
  });
}

/** Ventas por artículo de un día.
 *  Si el token guardado ha caducado, inicia sesión y reintenta una vez. */
export async function ventasDelDia(
  fecha: string,
  opciones: { token?: string; limite?: number; hasta?: string } = {}
): Promise<ArticuloVendido[]> {
  const limite = opciones.limite ?? 500;
  const hasta = opciones.hasta;
  let token = opciones.token ?? process.env.HIOPOS_TOKEN ?? "";

  let resp = token
    ? await pedirInforme(fecha, token, limite, hasta)
    : new Response(null, { status: 401 });

  if (resp.status === 401 || resp.status === 403 || resp.status === 500) {
    token = await login();
    await abrirSesion(token);
    resp = await pedirInforme(fecha, token, limite, hasta);
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
