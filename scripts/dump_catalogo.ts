// Vuelca el catálogo y las líneas no identificadas de la carta a ficheros
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, "..", ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const OUT = "C:/Users/junto/AppData/Local/Temp/claude/c--Users-junto-Desktop-BRUXI-MAXXX/382ec96d-8602-4c7f-a44b-4dfc1a716ab1/scratchpad";

(async () => {
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });

  const { data: vinos } = await supabase
    .from("vinos")
    .select("id, anio, bodega, nombre, tipo, pais, precio")
    .eq("activo", true)
    .order("id");
  const catalogo = (vinos ?? [])
    .map(
      (v) =>
        `ID:${v.id} | ${v.bodega} | ${v.nombre} | ${v.anio ?? "NV"} | ${v.tipo} | ${v.pais} | ${v.precio}€`
    )
    .join("\n");
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "catalogo.txt"), catalogo, "utf8");

  const { data: doc } = await supabase
    .from("documentos")
    .select("resultado")
    .eq("id", 14)
    .single();
  const noEnc = (doc?.resultado?.no_encontrados ?? []) as { texto: string }[];
  const lineas = noEnc
    .map((x, i) => `${i + 1}. ${x.texto.replace(" — en la carta pero no en el inventario", "")}`)
    .join("\n");
  fs.writeFileSync(path.join(OUT, "carta_no_identificadas.txt"), lineas, "utf8");

  // Descargar el PDF original de la carta
  const { data: blob, error } = await supabase.storage
    .from("documentos")
    .download("1784927739007_CARTA_SALA.pdf");
  if (blob) {
    fs.writeFileSync(
      path.join(OUT, "CARTA_SALA.pdf"),
      Buffer.from(await blob.arrayBuffer())
    );
    console.log("PDF de la carta descargado");
  } else {
    console.log("no se pudo descargar el PDF:", error?.message);
  }
  console.log(`catálogo: ${vinos?.length} vinos · no identificadas: ${noEnc.length}`);
  console.log(`ficheros en ${OUT}`);
})();
