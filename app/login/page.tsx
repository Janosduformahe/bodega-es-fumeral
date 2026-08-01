"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      // Si la cuenta está desactivada, la contraseña es correcta: decirle que
      // se ha equivocado le hace reintentar hasta chocar con el límite de intentos
      setError(
        error.code === "user_banned" || /banned/i.test(error.message)
          ? "Esta cuenta no tiene acceso ahora mismo. Habla con el responsable de la bodega."
          : "Email o contraseña incorrectos"
      );
      setLoading(false);
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-eyebrow">
          <span className="eyebrow">Es Fumeral · Cala Nova</span>
        </div>
        <div className="login-title">Mi Bodega</div>
        <div className="login-sub">La cava del restaurante</div>
        <div className="login-rule" aria-hidden="true" />
        {error && <div className="login-error">{error}</div>}
        <label className="login-label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="login-input"
          type="email"
          autoComplete="email"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label className="login-label" htmlFor="password">
          Contraseña
        </label>
        <input
          id="password"
          className="login-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="login-btn" type="submit" disabled={loading}>
          {loading ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
