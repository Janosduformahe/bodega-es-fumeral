// Extrae el contexto del código donde se llama al login, para ver qué envía
import fs from "fs";
import path from "path";

const SALIDA = path.join(__dirname, "login_contexto.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

(async () => {
  const r = await fetch(
    "https://cloudlicense.hiopos.com/auth/main.2b1ca997810917c3.js",
    { headers: { "user-agent": "Mozilla/5.0" } }
  );
  const js = await r.text();

  for (const clave of [
    "/ErpCloud/session/login",
    "getCustomerLoginType",
    "icgCloudOwnpackLogin",
  ]) {
    let desde = 0;
    let n = 0;
    while (n < 3) {
      const i = js.indexOf(clave, desde);
      if (i === -1) break;
      log(`\n═══ ${clave} (posición ${i}) ═══`);
      log(js.slice(Math.max(0, i - 900), i + 500).replace(/\s+/g, " "));
      desde = i + 1;
      n++;
    }
  }
})();
