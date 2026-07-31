import fs from "fs";
import path from "path";

const SALIDA = path.join(__dirname, "login_cifrado.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

(async () => {
  const r = await fetch(
    "https://cloudlicense.hiopos.com/auth/main.2b1ca997810917c3.js",
    { headers: { "user-agent": "Mozilla/5.0" } }
  );
  const js = await r.text();

  for (const clave of ["encryptAndEncodeBase64(", "getCustomerLoginType", "getCustomerOwnpackInfo"]) {
    const i = js.indexOf(clave);
    if (i !== -1) {
      log(`\n═══ ${clave} ═══`);
      log(js.slice(Math.max(0, i - 200), i + 900).replace(/\s+/g, " "));
    }
  }
})();
