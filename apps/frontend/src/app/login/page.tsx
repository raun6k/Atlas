"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/session", { method: "POST", body: form });
    if (!res.ok) {
      setError("Invalid operator credentials");
      return;
    }
    router.push("/");
    router.refresh();
  }
  return (
    <main className="login">
      <form onSubmit={onSubmit} data-testid="login-form">
        <span className="badge">RAZORPAY TEST MODE — SIMULATED</span>
        <h1>Operator sign-in</h1>
        <p className="muted">Merchant evidence console. Not a public storefront.</p>
        <input name="email" type="email" placeholder="merchant@quickmart.example" required data-testid="login-email" />
        <input name="password" type="password" required data-testid="login-password" />
        <button type="submit">Continue</button>
        {error ? <p className="muted">{error}</p> : null}
      </form>
    </main>
  );
}
