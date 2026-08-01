"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  MAX_CUENTAS,
  accesoLegible,
  generarPassword,
  iniciales,
  usuarioSugerido,
  type Miembro,
  type Rol,
} from "@/lib/equipo";

type Entrega = { nombre: string; email: string; password: string; nueva: boolean };

export default function EquipoCliente({ inicial }: { inicial: Miembro[] }) {
  const supabase = useMemo(() => createClient(), []);
  const [equipo, setEquipo] = useState<Miembro[]>(inicial);
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  // Hojas inferiores: alta, confirmación de algo peligroso y entrega de clave
  const [alta, setAlta] = useState<{ nombre: string; email: string; tocado: boolean } | null>(null);
  const [confirmar, setConfirmar] = useState<{
    titulo: string;
    detalle: string;
    accion: () => Promise<void>;
    peligro?: boolean;
    tecleaEl?: string;
  } | null>(null);
  const [tecleado, setTecleado] = useState("");
  const [entrega, setEntrega] = useState<Entrega | null>(null);
  const [copiado, setCopiado] = useState(false);

  const cupo = equipo.length;
  const lleno = cupo >= MAX_CUENTAS;

  async function recargar() {
    const { data } = await supabase.rpc("equipo_listar");
    setEquipo((data as Miembro[]) ?? []);
  }

  /** Envuelve cualquier llamada: bloquea, traduce el error de Postgres y recarga.
   *  El builder de supabase es "thenable", no una Promise: por eso PromiseLike. */
  async function ejecutar(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setOcupado(true);
    setError("");
    const { error } = await fn();
    setOcupado(false);
    if (error) {
      setError(error.message.replace(/^.*?:\s*/, ""));
      return false;
    }
    await recargar();
    return true;
  }

  async function crear() {
    if (!alta) return;
    const password = generarPassword();
    const nombre = alta.nombre.trim();
    const email = (alta.email || usuarioSugerido(nombre)).trim().toLowerCase();
    const ok = await ejecutar(() =>
      supabase.rpc("equipo_crear", {
        p_nombre: nombre,
        p_email: email,
        p_password: password,
        p_rol: "staff",
      })
    );
    if (!ok) return;
    setAlta(null);
    setEntrega({ nombre, email, password, nueva: true });
  }

  async function nuevaPassword(m: Miembro) {
    const password = generarPassword();
    const ok = await ejecutar(() =>
      supabase.rpc("equipo_password", { p_user_id: m.user_id, p_password: password })
    );
    if (!ok) return;
    setConfirmar(null);
    setEntrega({ nombre: m.nombre, email: m.email, password, nueva: false });
  }

  const cambiarRol = (m: Miembro, rol: Rol) =>
    ejecutar(() => supabase.rpc("equipo_cambiar_rol", { p_user_id: m.user_id, p_rol: rol }));

  const renombrar = (m: Miembro, nombre: string) => {
    if (!nombre.trim() || nombre.trim() === m.nombre) return;
    return ejecutar(() =>
      supabase.rpc("equipo_renombrar", { p_user_id: m.user_id, p_nombre: nombre })
    );
  };

  async function copiarDatos(e: Entrega) {
    const texto = `Mi Bodega · Es Fumeral\nUsuario: ${e.email}\nContraseña: ${e.password}`;
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      setError("No se ha podido copiar. Apúntala a mano.");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Equipo</div>
          <div className="page-sub">Quién entra en la bodega y qué puede hacer</div>
        </div>
      </div>

      <div className="eq-cabecera">
        <span className={`eq-cupo${lleno ? " lleno" : ""}`}>
          {cupo} de {MAX_CUENTAS} cuentas
        </span>
        <button
          className="eq-anadir"
          disabled={lleno || ocupado}
          onClick={() => setAlta({ nombre: "", email: "", tocado: false })}
        >
          + Añadir persona
        </button>
      </div>

      {error && <div className="eq-error">{error}</div>}
      {lleno && (
        <div className="eq-limite">
          Has llegado al máximo de {MAX_CUENTAS} cuentas. Para dar de alta a alguien nuevo,
          borra una cuenta que ya no se use.
        </div>
      )}

      <div className="eq-lista">
        {equipo.map((m) => (
          <div
            key={m.user_id}
            className={`eq-persona${m.rol === "admin" ? " anfitrion" : ""}${m.activo ? "" : " inactiva"}`}
          >
            <div className="eq-top">
              <span className={`eq-disco${m.rol === "admin" ? " anfitrion" : ""}`}>
                {iniciales(m.nombre)}
              </span>
              <div className="eq-quien">
                <input
                  className="eq-nombre"
                  defaultValue={m.nombre}
                  aria-label={`Nombre de ${m.nombre}`}
                  onBlur={(e) => renombrar(m, e.target.value)}
                />
                <div className="eq-email">{m.email}</div>
              </div>
              <div className="eq-sellos">
                {m.rol === "admin" && <span className="eq-sello anfitrion">Anfitrión</span>}
                {m.soy_yo && <span className="eq-sello">Tú</span>}
                {!m.activo && <span className="eq-sello inactiva">Sin acceso</span>}
              </div>
            </div>

            <div className="eq-acceso">{accesoLegible(m.ultimo_acceso)}</div>

            <div className="eq-acciones">
              <button
                className="eq-btn"
                disabled={ocupado}
                onClick={() =>
                  setConfirmar({
                    titulo: `Contraseña nueva para ${m.nombre}`,
                    detalle:
                      "Se genera una contraseña y se cierra su sesión en todos los dispositivos. Tendrás que dársela tú.",
                    accion: () => nuevaPassword(m),
                  })
                }
              >
                Contraseña nueva
              </button>

              {!m.soy_yo && (
                <button
                  className="eq-btn"
                  disabled={ocupado}
                  onClick={() =>
                    setConfirmar({
                      titulo:
                        m.rol === "admin"
                          ? `Que ${m.nombre} deje de ser anfitrión`
                          : `Hacer anfitrión a ${m.nombre}`,
                      detalle:
                        m.rol === "admin"
                          ? "Seguirá usando la bodega igual, pero dejará de poder gestionar las cuentas."
                          : "Podrá crear, editar y borrar cuentas del equipo, incluida la tuya.",
                      accion: async () => {
                        await cambiarRol(m, m.rol === "admin" ? "staff" : "admin");
                        setConfirmar(null);
                      },
                    })
                  }
                >
                  {m.rol === "admin" ? "Quitar anfitrión" : "Hacer anfitrión"}
                </button>
              )}

              {!m.soy_yo && (
                <button
                  className="eq-btn"
                  disabled={ocupado}
                  onClick={() =>
                    setConfirmar({
                      titulo: m.activo ? `Quitar el acceso a ${m.nombre}` : `Devolver el acceso a ${m.nombre}`,
                      detalle: m.activo
                        ? "No podrá entrar y se cerrará su sesión. Se puede deshacer cuando quieras: la cuenta y su historial se conservan."
                        : "Volverá a poder entrar con su contraseña de siempre.",
                      accion: async () => {
                        await ejecutar(() =>
                          supabase.rpc("equipo_activar", {
                            p_user_id: m.user_id,
                            p_activo: !m.activo,
                          })
                        );
                        setConfirmar(null);
                      },
                    })
                  }
                >
                  {m.activo ? "Quitar acceso" : "Devolver acceso"}
                </button>
              )}

              {!m.soy_yo && (
                <button
                  className="eq-btn borrar"
                  disabled={ocupado}
                  onClick={() => {
                    setTecleado("");
                    setConfirmar({
                      titulo: `Borrar la cuenta de ${m.nombre}`,
                      detalle:
                        "La cuenta desaparece para siempre y libera una plaza. Lo que hizo en la bodega se conserva, pero deja de llevar su nombre. Si sólo quieres cortarle el acceso, usa «Quitar acceso».",
                      peligro: true,
                      tecleaEl: m.nombre,
                      accion: async () => {
                        await ejecutar(() =>
                          supabase.rpc("equipo_borrar", { p_user_id: m.user_id })
                        );
                        setConfirmar(null);
                      },
                    });
                  }}
                >
                  Borrar
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {equipo.length === 1 && (
        <div className="eq-vacio">
          <strong>Todavía estás solo.</strong>
          Añade a quien atienda la sala para que puedan consultar existencias y descontar
          botellas sin pedirte el móvil.
        </div>
      )}

      {/* ── Alta ── */}
      {alta && (
        <div className="overlay" onClick={() => !ocupado && setAlta(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="grabber" />
            <div className="modal-title">Añadir persona</div>
            <div className="modal-sub">
              Podrá hacer lo mismo que tú en la bodega, salvo gestionar las cuentas.
            </div>

            <label className="modal-label">Nombre</label>
            <input
              className="eq-input"
              autoFocus
              value={alta.nombre}
              placeholder="Teo"
              onChange={(e) =>
                setAlta({
                  ...alta,
                  nombre: e.target.value,
                  email: alta.tocado ? alta.email : usuarioSugerido(e.target.value),
                })
              }
            />

            <label className="modal-label">Con qué usuario entra</label>
            <input
              className="eq-input"
              value={alta.email}
              placeholder="teo@esfumeral.com"
              onChange={(e) => setAlta({ ...alta, email: e.target.value, tocado: true })}
            />
            <div className="eq-pista">
              No hace falta que el correo exista: sólo es el usuario con el que entra.
            </div>

            <div className="modal-btns">
              <button className="btn-cancel" disabled={ocupado} onClick={() => setAlta(null)}>
                Cancelar
              </button>
              <button
                className="btn-confirm"
                disabled={ocupado || !alta.nombre.trim()}
                onClick={crear}
              >
                {ocupado ? "Creando…" : "Crear la cuenta"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirmación ── */}
      {confirmar && (
        <div className="overlay" onClick={() => !ocupado && setConfirmar(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="grabber" />
            <div className="modal-title">{confirmar.titulo}</div>
            <div className="modal-sub">{confirmar.detalle}</div>
            {confirmar.tecleaEl && (
              <>
                <label className="modal-label">
                  Escribe «{confirmar.tecleaEl}» para confirmar
                </label>
                <input
                  className="eq-input"
                  autoFocus
                  value={tecleado}
                  onChange={(e) => setTecleado(e.target.value)}
                />
              </>
            )}
            <div className="modal-btns">
              <button
                className="btn-cancel"
                disabled={ocupado}
                onClick={() => setConfirmar(null)}
              >
                Cancelar
              </button>
              <button
                className={confirmar.peligro ? "btn-borrar" : "btn-confirm"}
                disabled={
                  ocupado ||
                  (!!confirmar.tecleaEl && tecleado.trim() !== confirmar.tecleaEl)
                }
                onClick={() => confirmar.accion()}
              >
                {ocupado ? "Un momento…" : confirmar.peligro ? "Borrar para siempre" : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Entrega de la contraseña: se ve una sola vez ── */}
      {entrega && (
        <div className="overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="grabber" />
            <div className="modal-title">
              {entrega.nueva ? `${entrega.nombre} ya puede entrar` : `Contraseña nueva de ${entrega.nombre}`}
            </div>
            <div className="modal-sub">
              Apúntala o mándasela ahora: por seguridad no se guarda y no vas a poder volver a verla.
            </div>

            <div className="eq-credencial">
              <span className="eq-cred-etiqueta">Usuario</span>
              <span className="eq-cred-valor">{entrega.email}</span>
            </div>
            <div className="eq-credencial">
              <span className="eq-cred-etiqueta">Contraseña</span>
              <span className="eq-cred-valor clave">{entrega.password}</span>
            </div>

            <div className="modal-btns">
              <button className="btn-cancel" onClick={() => copiarDatos(entrega)}>
                {copiado ? "Copiado ✓" : "Copiar"}
              </button>
              <button className="btn-confirm" onClick={() => setEntrega(null)}>
                Ya la tengo apuntada
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
