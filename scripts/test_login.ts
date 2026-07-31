// Intenta el login de Hiopos Analytics replicando su cifrado
import fs from "fs";
import path from "path";
import crypto from "crypto";

const SALIDA = path.join(__dirname, "login_prueba.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

for (const l of fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

const CLAVE = "B1B2B3B4B5B6B7B8";

/** CryptoJS.AES.encrypt(texto, key=iv=CLAVE, CBC, Pkcs7).toString() → base64 */
function encriptar(txt: string): string {
  const c = crypto.createCipheriv("aes-128-cbc", Buffer.from(CLAVE), Buffer.from(CLAVE));
  return Buffer.concat([c.update(txt, "utf8"), c.final()]).toString("base64");
}

const USER = process.env.HIOPOS_USER!;
const PASS = process.env.HIOPOS_PASSWORD!;
const CUST = process.env.HIOPOS_CUSTOMER!;
const HOST = process.env.HIOPOS_HOST!;

async function intento(nombre: string, params: Record<string, string>) {
  const url = `${HOST}/ErpCloud/session/login?${new URLSearchParams(params)}`;
  try {
    const r = await fetch(url, {
      headers: { "Content-Type": "application/json", "user-agent": "Mozilla/5.0" },
    });
    const token = r.headers.get("x-auth-token");
    const cuerpo = (await r.text()).slice(0, 200);
    log(`\n── ${nombre}`);
    log(`   HTTP ${r.status} · x-auth-token: ${token ?? "(ninguno)"}`);
    if (cuerpo.trim()) log(`   cuerpo: ${cuerpo}`);
    return token;
  } catch (e) {
    log(`\n── ${nombre}\n   error: ${(e as Error).message}`);
    return null;
  }
}

(async () => {
  const encU = encriptar(USER);
  const encP = encriptar(PASS);
  log(`user cifrado:     ${encU}`);
  log(`password cifrado: ${encP}`);

  // 1) Mínimo: usuario, contraseña, cliente, analytics
  let t = await intento("mínimo + encrypted", {
    user: encU,
    password: encP,
    customerId: CUST,
    languageIsoCode: "ES",
    isAnalytics: "true",
    encrypted: "true",
  });

  // 2) Con specType e ipWS/portWS/dbName vacíos cifrados
  if (!t)
    t = await intento("con specType 2 y WS vacíos", {
      user: encU,
      password: encP,
      customerId: CUST,
      languageIsoCode: "ES",
      specType: "2",
      ipWS: encriptar(""),
      portWS: encriptar("0"),
      dbName: encriptar(""),
      isDocs: "false",
      isCloudDocs: "false",
      isAnalytics: "true",
      encrypted: "true",
    });

  // 3) Sin cifrar, por si acepta texto plano
  if (!t)
    t = await intento("texto plano", {
      user: USER,
      password: PASS,
      customerId: CUST,
      languageIsoCode: "ES",
      isAnalytics: "true",
    });

  log(t ? `\n✓ TOKEN OBTENIDO: ${t}` : "\n✗ ningún intento devolvió token");
})();
