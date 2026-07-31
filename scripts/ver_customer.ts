import fs from "fs";
import path from "path";

const SALIDA = path.join(__dirname, "customer_info.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

(async () => {
  const r = await fetch("https://cloudlicense.hiopos.com/auth/main.2b1ca997810917c3.js", {
    headers: { "user-agent": "Mozilla/5.0" },
  });
  const js = await r.text();

  // ¿Dónde se rellenan ipWS / dbName / datasourceList?
  log("═══ endpoints del servidor de licencias ═══");
  const eps = new Set(
    [...js.matchAll(/["'`](\/services\/[\w/]+)["'`]/g)].map((m) => m[1])
  );
  log([...eps].join("\n"));

  log("\n═══ contexto de datasourceList ═══");
  let d = 0;
  let n = 0;
  while (n < 2) {
    const i = js.indexOf("datasourceList", d);
    if (i === -1) break;
    const t = js.slice(Math.max(0, i - 700), i + 200).replace(/\s+/g, " ");
    if (!t.includes('append("datasourceList"')) {
      log(`\n─── ${i} ───\n${t}`);
      n++;
    }
    d = i + 1;
  }
})();
