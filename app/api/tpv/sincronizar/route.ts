import { NextResponse, type NextRequest } from "next/server";
import { createClient as createAdmin } from "@supabase/supabase-js";
import { ventasDelDia } from "@/lib/hiopos";
import { casarVentas, type LineaVenta } from "@/lib/ventas-tpv";
import { createClient } from "@/lib/supabase/server";
import type { Vino } from "@/lib/types";

export const maxDuration = 60;

/** Descarga las ventas de un día de HioPOS Analytics, las casa con el
 *  catálogo y deja un cierre PENDIENTE DE REVISIÓN (nunca aplica solo).
 *
 *  Se puede llamar de dos formas:
 *   · desde la app, con la sesión del usuario (botón "Traer ventas de ayer")
 *   · desde el cron de Vercel, con la cabecera Authorization: Bearer CRON_SECRET
 */
export async function GET(req: NextRequest) {
  const fecha =
    req.nextUrl.searchParams.get("fecha") ??
    new Date(Date.now() - 86400000).toISOString().slice(0, 10); // ayer

  // ── Autorización: cron con secreto, o usuario con sesión ──
  const auth = req.headers.get("authorization");
  const esCron =
    !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;

  let userId: string | null = null;
  if (!esCron) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    userId = user.id;
  }

  // El cron no tiene sesión: necesita la clave de servicio para escribir
  const db = esCron
    ? createAdmin(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )
    : await createClient();

  try {
    const ventas = await ventasDelDia(fecha);
    if (!ventas.length) {
      return NextResponse.json({ fecha, mensaje: "Sin ventas ese día", items: 0 });
    }

    const { data: vinosData } = await db
      .from("vinos")
      .select("*")
      .eq("activo", true)
      .order("id");
    const vinos = (vinosData ?? []) as Vino[];

    const { data: aliasRows } = await db.from("alias_carta").select("texto_norm, vino_id");
    const alias = new Map<string, number>(
      (aliasRows ?? []).map((a: { texto_norm: string; vino_id: number }) => [
        a.texto_norm,
        a.vino_id,
      ])
    );

    const lineas: LineaVenta[] = ventas.map((v) => ({
      texto: v.nombre,
      unidades: v.unidades,
      codigo: v.codigo,
    }));
    const resultado = casarVentas(
      lineas,
      vinos,
      alias,
      `Ventas del TPV · ${fecha}`
    );

    // Un cierre por día: si ya existe uno sin aplicar, se reemplaza
    const nombre = `TPV ${fecha}`;
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

    return NextResponse.json({
      fecha,
      documento_id: doc.id,
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
