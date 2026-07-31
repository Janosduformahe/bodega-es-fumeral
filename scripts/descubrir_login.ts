// Busca el endpoint de autenticación de Hiopos Analytics analizando
// los recursos públicos de la página de login.
import fs from "fs";
import path from "path";

const SALIDA = path.join(__dirname, "login_descubierto.txt");
const buf: string[] = [];
const log = (s = "") => buf.push(s);
process.on("exit", () => fs.writeFileSync(SALIDA, buf.join("\n"), "utf8"));

const BASE = "https://cloudlicense.hiopos.com";

(async () => {
  const idx = await fetch(`${BASE}/auth/`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
  });
  log(`GET /auth/ → ${idx.status}`);
  const html = await idx.text();

  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  log(`scripts: ${scripts.join(" · ")}\n`);

  const patrones = [
    /["'`](\/?[\w\-/.]*(?:login|authenticate|signin|token|session)[\w\-/.]*)["'`]/gi,
    /https?:\/\/[\w.-]*hiopos[\w.-]*\/[\w\-/.]*/gi,
  ];

  for (const s of scripts) {
    const url = s.startsWith("http") ? s : `${BASE}/auth/${s.replace(/^\.?\//, "")}`;
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
      const txt = await r.text();
      log(`── ${url} (${r.status}, ${Math.round(txt.length / 1024)} KB)`);
      const encontrados = new Set<string>();
      for (const p of patrones) {
        for (const m of txt.matchAll(p)) {
          const v = (m[1] ?? m[0]).trim();
          if (v.length > 3 && v.length < 120) encontrados.add(v);
        }
      }
      [...encontrados]
        .filter((v) => /login|auth|token|session|api/i.test(v))
        .slice(0, 40)
        .forEach((v) => log(`     ${v}`));
    } catch (e) {
      log(`   error en ${url}: ${(e as Error).message}`);
    }
  }
})();
