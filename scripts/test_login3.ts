// Matriz de variantes del login para dar con el contexto que acepta el informe
import fs from "fs";
import path from "path";
import crypto from "crypto";

const SALIDA = path.join(__dirname, "login_matriz.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

const CLAVE = "B1B2B3B4B5B6B7B8";
const cif = (t: string) => {
  const c = crypto.createCipheriv("aes-128-cbc", Buffer.from(CLAVE), Buffer.from(CLAVE));
  return Buffer.concat([c.update(t, "utf8"), c.final()]).toString("base64");
};

const HOST = process.env.HIOPOS_HOST!;
const CUST = process.env.HIOPOS_CUSTOMER!;
const U = cif(process.env.HIOPOS_USER!);
const P = cif(process.env.HIOPOS_PASSWORD!);

async function ds() {
  const r = await fetch(
    `https://cloudlicense.hiopos.com/services/cloud/getCustomerAnalyticsDB?customerId=${CUST}`
  );
  const xml = await r.text();
  return [...xml.matchAll(/<datasourceList>(\d+)<\/datasourceList>/g)].map((m) => m[1]).join(",");
}

async function probar(nombre: string, extra: Record<string, string>) {
  const params = new URLSearchParams({
    user: U,
    password: P,
    customerId: CUST,
    languageIsoCode: "ES",
    encrypted: "true",
    ...extra,
  });
  const lr = await fetch(`${HOST}/ErpCloud/session/login?${params}`, {
    headers: { "Content-Type": "application/json" },
  });
  const token = lr.headers.get("x-auth-token");
  if (!token) {
    log(`${nombre.padEnd(38)} login ${lr.status} · sin token`);
    return null;
  }
  // Probar el informe con ese token
  const qr = await fetch(process.env.HIOPOS_URL!, {
    method: "POST",
    headers: { "content-type": "application/json", "x-auth-token": token },
    body: JSON.stringify({
      offset: 0,
      limit: 3,
      totals: false,
      rest: false,
      datasources: [{ id: 250 }],
      columns: [
        {
          "@type": "BlockColumn",
          internalId: 2,
          attributeId: 2,
          position: 2,
          name: "Articulo",
          shortName: "Articulo",
          type: "String",
          columnType: 1,
          sourceType: "Attribute",
          shown: true,
          isAttribute: true,
          isMetric: false,
          totalType: "NONE",
          blockId: 9826,
          styles: [],
          childrenPositions: [],
          metadataSortings: [],
          localizedTitles: {},
          localizedSubtitles: {},
          dashboardFormulas: {},
        },
      ],
      filters: [],
      dashboard: 118,
      block: 9826,
      id: 3,
      dateReference: "2026-07-31",
    }),
  });
  const txt = (await qr.text()).slice(0, 120).replace(/\s+/g, " ");
  log(`${nombre.padEnd(38)} login OK · informe ${qr.status} · ${txt}`);
  return qr.ok ? token : null;
}

(async () => {
  const lista = await ds();
  const hoy = new Date().toISOString().slice(0, 10);
  const variantes: [string, Record<string, string>][] = [
    ["A mínimo", { isAnalytics: "true" }],
    ["B +specType2", { isAnalytics: "true", specType: "2" }],
    ["C +datasources", { isAnalytics: "true", specType: "2", datasourceList: lista }],
    [
      "D +workDate yyyyMMdd",
      {
        isAnalytics: "true",
        specType: "2",
        datasourceList: lista,
        workDate: `'${hoy.replace(/-/g, "")}'`,
      },
    ],
    [
      "E +ipWS/dbName vacíos cifrados",
      {
        isAnalytics: "true",
        specType: "2",
        datasourceList: lista,
        ipWS: cif(""),
        portWS: cif("1"),
        dbName: cif(""),
        workDate: `'${hoy.replace(/-/g, "")}'`,
        marginCost: "false",
        isDocs: "false",
        isCloudDocs: "false",
        budget: "true",
        freeFields: "false",
      },
    ],
    [
      "F ipWS/dbName planos vacíos",
      {
        isAnalytics: "true",
        specType: "2",
        datasourceList: lista,
        ipWS: "",
        portWS: "1",
        dbName: "",
        workDate: `'${hoy.replace(/-/g, "")}'`,
      },
    ],
    ["G isErp en vez de isAnalytics", { isErp: "true", specType: "2", datasourceList: lista }],
  ];
  for (const [n, e] of variantes) {
    try {
      const ok = await probar(n, e);
      if (ok) {
        log(`\n✓✓ FUNCIONA con la variante "${n}" · token ${ok}`);
        break;
      }
    } catch (err) {
      log(`${n.padEnd(38)} error: ${(err as Error).message}`);
    }
  }
})();
