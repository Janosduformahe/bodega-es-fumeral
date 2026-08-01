// Tipos y utilidades de la gestión de equipo. Sin secretos: todo pasa por
// funciones SECURITY DEFINER de Postgres que comprueban el rol por dentro.

export type Rol = "admin" | "staff";

export type Miembro = {
  user_id: string;
  nombre: string;
  rol: Rol;
  email: string;
  ultimo_acceso: string | null;
  alta: string;
  activo: boolean;
  soy_yo: boolean;
};

export const MAX_CUENTAS = 4;

/** Alfabeto sin caracteres que se confundan al dictarlos por teléfono */
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Contraseña de 12 caracteres en tres grupos, fácil de leer en voz alta */
export function generarPassword(): string {
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((g) => g.join(""))
    .join("-");
}

/** "Marta Pérez" → "marta" (para proponer el usuario) */
export function usuarioSugerido(nombre: string): string {
  const base = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);
  return base ? `${base}@esfumeral.com` : "";
}

export function accesoLegible(iso: string | null): string {
  if (!iso) return "Nunca ha entrado";
  const d = new Date(iso);
  const dias = Math.floor((Date.now() - d.getTime()) / 86400000);
  const hora = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  if (dias === 0) return `Hoy ${hora}`;
  if (dias === 1) return `Ayer ${hora}`;
  if (dias < 7) return `Hace ${dias} días`;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
}

export const iniciales = (nombre: string) =>
  nombre
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
