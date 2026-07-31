// Login completo: datos de la BD analítica del cliente + sesión
import fs from "fs";
import path from "path";
import crypto from "crypto";

const SALIDA = path.join(__dirname, "login_prueba2.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

const CLAVE = "B1B2B3B4B5B6B7B8";
const cifrar = (t: string) => {
  const c = crypto.createCipheriv("aes-128-cbc", Buffer.from(CLAVE), Buffer.from(CLAVE));
  return Buffer.concat([c.update(t, "utf8"), c.final()]).toString("base64");
};
const tag = (xml: string, t: string) => {
  const a = xml.indexOf(`<${t}>`);
  if (a === -1) return "";
  return xml.slice(a + t.length + 2, xml.indexOf(`</${t}>`, a));
};

(async () => {
  const CUST = process.env.HIOPOS_CUSTOMER!;
  const r = await fetch(
    `https://cloudlicense.hiopos.com/services/cloud/getCustomerAnalyticsDB?customerId=${CUST}`,
    { headers: { "Content-Type": "text/xml", "user-agent": "Mozilla/5.0" } }
  );
  const xml = await r.text();
  log(`getCustomerAnalyticsDB → ${r.status}`);
  log(xml.slice(0, 1500));

  const ipWS = tag(xml, "ipAddress");
  const portWS = tag(xml, "port");
  const dbName = tag(xml, "dbName");
  const specTypeTxt = tag(xml, "specType");
  const specType = specTypeTxt === "HioPos" ? "2" : specTypeTxt === "FrontRest" ? "3" : "1";
  // El XML trae una etiqueta <datasourceList> por cada origen: hay que todas
  const datasourceList = [...xml.matchAll(/<datasourceList>(\d+)<\/datasourceList>/g)]
    .map((m) => m[1])
    .join(",");
  log(`\nipWS=${ipWS} port=${portWS} db=${dbName} specType=${specTypeTxt}(${specType}) ds=${datasourceList}`);

  const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const params = new URLSearchParams({
    user: cifrar(process.env.HIOPOS_USER!),
    password: cifrar(process.env.HIOPOS_PASSWORD!),
    customerId: CUST,
    languageIsoCode: "ES",
    specType,
    ipWS: cifrar(ipWS),
    portWS: cifrar(portWS),
    dbName: cifrar(dbName),
    workDate: `'${hoy}'`,
    datasourceList,
    marginCost: String(xml.includes("<groupList>8</groupList>")),
    isDocs: "false",
    isCloudDocs: "false",
    isAnalytics: "true",
    budget: "true",
    freeFields: String(xml.includes("<groupList>11</groupList>")),
    encrypted: "true",
  });

  const host = process.env.HIOPOS_HOST!;
  const lr = await fetch(`${host}/ErpCloud/session/login?${params}`, {
    headers: { "Content-Type": "application/json" },
  });
  const token = lr.headers.get("x-auth-token");
  log(`\nlogin → ${lr.status} · token: ${token ?? "(ninguno)"}`);

  if (token) {
    process.env.HIOPOS_TOKEN = token;
    const { ventasDelDia } = await import("../lib/hiopos");
    try {
      const v = await ventasDelDia("2026-07-31", { token });
      log(`\n✓ CONSULTA OK con el token nuevo: ${v.length} artículos`);
      v.slice(0, 5).forEach((x) => log(`   ${x.unidades} × ${x.nombre} (${x.venta} €)`));
    } catch (e) {
      log(`\n✗ consulta falló: ${(e as Error).message}`);
    }
  }
})();
