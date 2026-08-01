import { NextResponse, type NextRequest } from "next/server";
import { createClient as createPlano } from "@supabase/supabase-js";
import { ventasDelDia } from "@/lib/hiopos";
import { casarVentas, type LineaVenta } from "@/lib/ventas-tpv";
import { createClient } from "@/lib/supabase/server";
import type { ResultadoDocumento, Vino } from "@/lib/types";

export const maxDuration = 60;

/** Descarga las ventas de un día de HioPOS Analytics, las casa con el
 *  catálogo y deja un cierre PENDIENTE DE REVISIÓN (nunca aplica solo).
 *
 *  Se puede llamar de dos formas:
 *   · desde la app, con la sesión del usuario (botón "Traer ventas de ayer")
 *   · desde el cron de Vercel, con la cabecera Authorization: Bearer CRON_SECRET
 *
 *  El cron NO usa la service role key: escribe a través de dos funciones
 *  SECURITY DEFINER que validan el mismo secreto contra config_privada. Así
 *  no hay en Vercel ninguna credencial capaz de saltarse la seguridad de la
 *  base de datos, y el cron sólo puede hacer exactamente estas dos cosas.
 */
export async function GET(req: NextRequest) {
  const fecha =
    req.nextUrl.searchParams.get("fecha") ??
    new Date(Date.now() - 86400000).toISOString().slice(0, 10); // ayer

  const auth = req.headers.get("authorization");
  const secreto = process.env.CRON_SECRET;
  const esCron = !!secreto && auth === `Bearer ${secreto}`;

  // Si viene con cabecera de cron pero el secreto no cuadra, no se cae hacia
  // la ruta de usuario: se rechaza sin más.
  if (!esCron && auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Secreto de cron inválido" }, { status: 401 });
  }

  let userId: string | null = null;
  if (!esCron) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    userId = user.id;
  }

  try {
    const ventas = await ventasDelDia(fecha);
    if (!ventas.length) {
      return NextResponse.json({ fecha, mensaje: "Sin ventas ese día", items: 0 });
    }

    const lineas: LineaVenta[] = ventas.map((v) => ({
      texto: v.nombre,
      unidades: v.unidades,
      codigo: v.codigo,
      importe: v.venta,
    }));
    const nombre = `TPV ${fecha}`;

    let vinos: Vino[];
    let alias: Map<string, number>;
    let resultado: ResultadoDocumento;
    let documentoId: number;

    if (esCron) {
      // Sin sesión: todo pasa por las funciones protegidas por el secreto
      const db = createPlano(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { persistSession: false } }
      );
      const { data: cat, error: eCat } = await db.rpc("cron_catalogo", {
        p_secreto: secreto,
      });
      if (eCat) throw new Error("catálogo: " + eCat.message);
      const c = cat as { vinos: Vino[]; alias: { texto_norm: string; vino_id: number }[] };
      vinos = c.vinos ?? [];
      alias = new Map((c.alias ?? []).map((a) => [a.texto_norm, a.vino_id]));

      resultado = casarVentas(lineas, vinos, alias, `Ventas del TPV · ${fecha}`);

      const { data: id, error: eDoc } = await db.rpc("cron_guardar_cierre", {
        p_secreto: secreto,
        p_nombre: nombre,
        p_resultado: resultado,
      });
      if (eDoc) throw new Error("guardar: " + eDoc.message);
      documentoId = id as number;
    } else {
      const db = await createClient();
      const { data: vinosData } = await db
        .from("vinos")
        .select("*")
        .eq("activo", true)
        .order("id");
      vinos = (vinosData ?? []) as Vino[];

      const { data: aliasRows } = await db.from("alias_carta").select("texto_norm, vino_id");
      alias = new Map<string, number>(
        (aliasRows ?? []).map((a: { texto_norm: string; vino_id: number }) => [
          a.texto_norm,
          a.vino_id,
        ])
      );

      resultado = casarVentas(lineas, vinos, alias, `Ventas del TPV · ${fecha}`);

      // Un cierre por día: si ya existe uno sin aplicar, se reemplaza
      await db
        .from("documentos")
        .delete()
        .eq("tipo", "cierre")
        .eq("nombre_archivo", nombre)
        .eq("aplicado", false);

      const { data: doc, error } = await db
        .from("documentos")
        .insert({
          tipo: "cierre",
          nombre_archivo: nombre,
          modelo_ia: "HioPOS Analytics · casado en código",
          resultado,
          user_id: userId,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      documentoId = doc.id;
    }

    return NextResponse.json({
      fecha,
      documento_id: documentoId,
      articulos: ventas.length,
      casados: resultado.tpv_items?.length ?? 0,
      sugerencias: resultado.carta_sugerencias?.length ?? 0,
      sin_casar: resultado.carta_sin_casar?.length ?? 0,
      botellas: (resultado.tpv_items ?? []).reduce((s, i) => s + Math.abs(i.qty), 0),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error inesperado";
    return NextResponse.json({ error: msg, fecha }, { status: 500 });
  }
}
