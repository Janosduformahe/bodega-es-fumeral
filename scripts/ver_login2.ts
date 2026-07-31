// Busca dónde se INVOCA loginErpUser y cómo se construyen sus parámetros
import fs from "fs";
import path from "path";

const SALIDA = path.join(__dirname, "login_params.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

(async () => {
  const r = await fetch(
    "https://cloudlicense.hiopos.com/auth/main.2b1ca997810917c3.js",
    { headers: { "user-agent": "Mozilla/5.0" } }
  );
  const js = await r.text();

  // Invocaciones (no la definición)
  log("═══ INVOCACIONES DE loginErpUser ═══");
  let d = 0;
  let n = 0;
  while (n < 4) {
    const i = js.indexOf("loginErpUser(", d);
    if (i === -1) break;
    const trozo = js.slice(Math.max(0, i - 1400), i + 300).replace(/\s+/g, " ");
    if (!trozo.includes("loginErpUser(e,n,a){")) {
      log(`\n─── posición ${i} ───`);
      log(trozo);
      n++;
    }
    d = i + 1;
  }

  log("\n\n═══ FUNCIÓN encrypt ═══");
  const e = js.indexOf("encrypt(e){");
  if (e !== -1) log(js.slice(e, e + 700).replace(/\s+/g, " "));

  log("\n\n═══ append( de parámetros cerca del login ═══");
  const zona = js.slice(340000, 360000);
  const appends = [...zona.matchAll(/append\("([^"]+)"/g)].map((m) => m[1]);
  log([...new Set(appends)].join(" · "));
})();
