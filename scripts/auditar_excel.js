// Audita duplicados en el Excel y calcula la suma real de junio (cada vino una vez)
const XLSX = require("xlsx");

const wb = XLSX.readFile(
  "C:/Users/junto/Desktop/BRUXI MAXXX/downloadbyjanos/Copia de INVENTARIO BUENO bueno buenisimo (1).xlsx"
);
const rows = XLSX.utils.sheet_to_json(wb.Sheets["VINO"], { header: 1 });
const hdr = rows[0];
const iJun = hdr.indexOf(46174);
const iNombre = hdr.indexOf("Nombre");
const iBodega = hdr.findIndex((h) => String(h).trim() === "Bodega");
const iAnio = hdr.findIndex((h) => String(h).trim() === "Año");
const iTalla = hdr.indexOf("Talla");

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

const mapa = new Map();
for (let r = 1; r < rows.length; r++) {
  const row = rows[r] || [];
  const nombre = row[iNombre];
  const bodega = row[iBodega];
  if (
    typeof nombre === "string" &&
    nombre.trim() &&
    typeof bodega === "string" &&
    bodega.trim()
  ) {
    const clave =
      norm(bodega) + "|" + norm(nombre) + "|" + (row[iAnio] ?? "") + "|" + norm(row[iTalla]);
    const j = Number(row[iJun]);
    if (!mapa.has(clave)) mapa.set(clave, { n: 0, juns: [], filas: [] });
    const e = mapa.get(clave);
    e.n++;
    e.filas.push(r + 1);
    if (!isNaN(j)) e.juns.push(j);
  }
}

let unicos = 0,
  dupes = 0,
  sumUltimo = 0,
  sumPrimero = 0,
  conJun = 0;
const dupeEj = [];
for (const [k, e] of mapa) {
  if (e.n > 1) {
    dupes++;
    if (dupeEj.length < 8)
      dupeEj.push(
        k.split("|").slice(0, 2).join(" / ") +
          ` x${e.n} (filas ${e.filas.join(",")}) juns=` +
          JSON.stringify(e.juns)
      );
  } else unicos++;
  if (e.juns.length) {
    conJun++;
    sumUltimo += e.juns[e.juns.length - 1];
    sumPrimero += e.juns[0];
  }
}
console.log(`vinos distintos: ${mapa.size} (unicos: ${unicos}, repetidos: ${dupes})`);
console.log(`distintos con valor en junio: ${conJun}`);
console.log(`suma junio (tomando el PRIMER listado de cada vino): ${sumPrimero}`);
console.log(`suma junio (tomando el ULTIMO listado de cada vino): ${sumUltimo}`);
console.log("ejemplos de vinos listados varias veces:");
dupeEj.forEach((d) => console.log("  -", d));
