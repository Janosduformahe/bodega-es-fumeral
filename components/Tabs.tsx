"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function Tabs({ esAnfitrion }: { esAnfitrion?: boolean } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [hoja, setHoja] = useState(false);
  const [yo, setYo] = useState<{ nombre: string; rol: string } | null>(null);

  useEffect(() => {
    let vivo = true;
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase
        .from("perfiles")
        .select("nombre, rol")
        .eq("user_id", user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (vivo && data) setYo(data as { nombre: string; rol: string });
        });
    });
    return () => {
      vivo = false;
    };
  }, [supabase]);

  const anfitrion = esAnfitrion ?? yo?.rol === "admin";

  async function cerrarSesion() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      <nav className="tabs" aria-label="Navegación principal">
        <div className="tabs-inner">
          <span className="tabs-brand">Mi Bodega</span>
          <Link href="/" className={`tab${pathname === "/" ? " active" : ""}`}>
            <span className="tab-ico">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </span>
            Inventario
          </Link>
          <Link
            href="/ventas"
            className={`tab${pathname === "/ventas" || pathname === "/compras" ? " active" : ""}`}
          >
            <span className="tab-ico">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 3v18h18" />
                <path d="m19 9-5 5-4-4-3 3" />
              </svg>
            </span>
            Análisis
          </Link>
          <Link
            href="/documentos"
            className={`tab${pathname === "/documentos" ? " active" : ""}`}
          >
            <span className="tab-ico">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </span>
            Documentos
          </Link>
          <Link
            href="/historial"
            className={`tab${pathname === "/historial" ? " active" : ""}`}
          >
            <span className="tab-ico">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
            Historial
          </Link>
          {/* Antes era "Salir" a pelo: un toque accidental en plena sala cerraba
              la sesión. Ahora abre la hoja de cuenta, que es también donde vive Equipo. */}
          <button
            className={`tab${pathname === "/equipo" ? " active" : ""}`}
            onClick={() => setHoja(true)}
          >
            <span className="tab-ico">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </span>
            Cuenta
          </button>
        </div>
      </nav>

      {/* Hermana del nav, no dentro: .tabs tiene backdrop-filter y recortaría
          cualquier position:fixed que colgase de él. */}
      {hoja && (
        <div className="overlay" onClick={() => setHoja(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="grabber" />
            <div className="modal-title">{yo?.nombre ?? "Tu cuenta"}</div>
            <div className="modal-sub">
              {anfitrion ? "Anfitrión de la bodega" : "Equipo de sala"}
            </div>
            {anfitrion && (
              <Link href="/equipo" className="hoja-opcion" onClick={() => setHoja(false)}>
                <span>Equipo</span>
                <span className="hoja-flecha">→</span>
              </Link>
            )}
            <button className="hoja-opcion salir" onClick={cerrarSesion}>
              <span>Cerrar sesión</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
