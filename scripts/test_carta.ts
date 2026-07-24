// Prueba end-to-end de aplicar una carta: marca 3 vinos, verifica y revierte
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

(async () => {
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: auth, error: e0 } = await supabase.auth.signInWithPassword({
    email: "equipo@esfumeral.com",
    password: "EsFumeral2026!",
  });
  if (e0) throw e0;

  const { data: vinos } = await supabase
    .from("vinos")
    .select("id, bodega, nombre, precio, en_carta")
    .eq("activo", true)
    .order("id")
    .limit(3);
  const ids = (vinos ?? []).map((v) => v.id);
  console.log("vinos de prueba:", ids.join(", "));

  const { data: doc, error: e1 } = await supabase
    .from("documentos")
    .insert({
      tipo: "carta",
      nombre_archivo: "TEST-carta.pdf",
      resultado: {
        carta_ids: ids,
        movimientos: [],
        precios: [{ vino_id: ids[0], precio_nuevo: 999 }],
      },
      user_id: auth.user!.id,
    })
    .select("id")
    .single();
  if (e1) throw e1;

  const { data: res, error: e2 } = await supabase.rpc("aplicar_documento", {
    p_documento_id: doc.id,
  });
  if (e2) throw e2;
  console.log("resultado RPC:", JSON.stringify(res));

  const { count: enCarta } = await supabase
    .from("vinos")
    .select("*", { count: "exact", head: true })
    .eq("activo", true)
    .eq("en_carta", true);
  const { data: v0 } = await supabase
    .from("vinos")
    .select("precio, en_carta, carta_actualizada")
    .eq("id", ids[0])
    .single();
  console.log(`vinos en carta ahora: ${enCarta} (esperado 3)`);
  console.log(`precio del primero: ${v0?.precio} (esperado 999) · en_carta: ${v0?.en_carta} · fecha: ${v0?.carta_actualizada ? "sí" : "no"}`);

  // Revertir: quitar el marcado de carta y borrar el documento de prueba
  await supabase.from("vinos").update({ precio: vinos![0].precio }).eq("id", ids[0]);
  await supabase.from("vinos").update({ en_carta: false, carta_actualizada: null }).eq("activo", true);
  await supabase.from("documentos").delete().eq("id", doc.id);
  const { count: tras } = await supabase
    .from("vinos")
    .select("*", { count: "exact", head: true })
    .eq("activo", true)
    .eq("en_carta", true);
  console.log(`revertido · vinos en carta: ${tras} (esperado 0)`);
})().catch((e) => {
  console.error("FALLO:", e.message ?? e);
  process.exit(1);
});
