import { redirect } from "next/navigation";
import Tabs from "@/components/Tabs";
import { createClient } from "@/lib/supabase/server";
import type { Miembro } from "@/lib/equipo";
import EquipoCliente from "./EquipoCliente";

// El corte de rol se hace aquí, en servidor, no sólo escondiendo botones.
// Aun así la barrera real está en Postgres: las funciones equipo_* exigen
// es_admin() por dentro, así que llamarlas a mano tampoco sirve de nada.
export default async function EquipoPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: perfil } = await supabase
    .from("perfiles")
    .select("rol")
    .eq("user_id", user.id)
    .maybeSingle();
  if (perfil?.rol !== "admin") redirect("/");

  const { data } = await supabase.rpc("equipo_listar");

  return (
    <>
      <Tabs esAnfitrion />
      <EquipoCliente inicial={(data as Miembro[]) ?? []} />
    </>
  );
}
