import fs from "fs";
import path from "path";

const SALIDA = path.join(__dirname, "front_init.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

(async () => {
  const base = "https://cloudclient67.hiopos.com/icgfront";
  const idx = await fetch(`${base}/analytics`, { headers: { "user-agent": "Mozilla/5.0" } });
  const html = await idx.text();
  log(`GET /icgfront/analytics → ${idx.status}`);
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  log(`scripts: ${scripts.join(" · ")}\n`);

  for (const s of scripts) {
    const url = s.startsWith("http")
      ? s
      : `${base}/${s.replace(/^\.?\//, "")}`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    const js = await r.text();
    if (js.length < 50000) continue;
    log(`── ${url} (${Math.round(js.length / 1024)} KB)`);
    const eps = new Set(
      [...js.matchAll(/["'`](\/ErpCloud\/[\w/]+)["'`]/g)].map((m) => m[1])
    );
    log("  endpoints ErpCloud:");
    [...eps].forEach((e) => log(`     ${e}`));

    // ¿Qué se llama al arrancar la sesión?
    for (const clave of ["session/", "loginInfo", "setSession", "/session"]) {
      let d = 0;
      let n = 0;
      while (n < 2) {
        const i = js.indexOf(clave, d);
        if (i === -1) break;
        log(`\n  ··· ${clave} @${i}: ${js.slice(Math.max(0, i - 250), i + 250).replace(/\s+/g, " ")}`);
        d = i + 1;
        n++;
      }
    }
  }
})();
