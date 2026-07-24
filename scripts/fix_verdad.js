// Re-extrae la verdad de referencia del output del workflow en UTF-8 limpio
const fs = require("fs");
const SRC =
  "C:/Users/junto/AppData/Local/Temp/claude/c--Users-junto-Desktop-BRUXI-MAXXX/382ec96d-8602-4c7f-a44b-4dfc1a716ab1/tasks/wwv52csxb.output";
const DST =
  "C:/Users/junto/AppData/Local/Temp/claude/c--Users-junto-Desktop-BRUXI-MAXXX/382ec96d-8602-4c7f-a44b-4dfc1a716ab1/scratchpad/verdad_carta.json";

const j = JSON.parse(fs.readFileSync(SRC, "utf8"));
const res = j.result.resultados;
fs.writeFileSync(DST, JSON.stringify(res, null, 2), "utf8");
console.log(`${res.length} líneas · con match: ${res.filter((r) => r.vino_id !== null).length}`);
console.log("muestra:", res.find((r) => r.texto.includes("rate"))?.texto);
