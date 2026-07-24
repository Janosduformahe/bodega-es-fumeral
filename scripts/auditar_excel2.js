// Top valores de la columna junio + comparación con la BD por matching normalizado
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const wb = XLSX.readFile(
  "C:/Users/junto/Desktop/BRUXI MAXXX/downloadbyjanos/Copia de INVENTARIO BUENO bueno buenisimo (1).xlsx"
);
const rows = XLSX.utils.sheet_to_json(wb.Sheets["VINO"], { header: 1 });
const hdr = rows[0];
const iJun = hdr.indexOf(46174);
const iNombre = hdr.indexOf("Nombre");
const iBodega = hdr.findIndex((h) => String(h).trim() === "Bodega");
const iAnio = hdr.findIndex((h) => String(h).trim() === "Año");

const vinosExcel = [];
for (let r = 1; r < rows.length; r++) {
  const row = rows[r] || [];
  const nombre = row[iNombre];
  const bodega = row[iBodega];
  if (typeof nombre === "string" && nombre.trim() && typeof bodega === "string" && bodega.trim()) {
    const j = Number(row[iJun]);
    if (!isNaN(j))
      vinosExcel.push({
        fila: r + 1,
        bodega: bodega.trim(),
        nombre: nombre.trim(),
        anio: row[iAnio],
        jun: j,
        ancho: row.length,
      });
  }
}

console.log("── TOP 15 por valor de junio ──");
[...vinosExcel]
  .sort((a, b) => b.jun - a.jun)
  .slice(0, 15)
  .forEach((v) =>
    console.log(`fila ${v.fila} (${v.ancho} cols): ${v.bodega} / ${v.nombre} (${v.anio ?? "-"}) -> ${v.jun}`)
  );

console.log("\nfilas con más columnas que la cabecera:", vinosExcel.filter((v) => v.ancho > hdr.length).length, "de", vinosExcel.length);
