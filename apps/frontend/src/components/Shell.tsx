import Link from "next/link";
import { ClaimsBanner } from "./ClaimsBanner";

const NAV = [
  ["/", "Home"],
  ["/sellability", "Sellability"],
  ["/growth", "Growth"],
  ["/commerce", "Commerce"],
  ["/merchant", "Merchant"],
  ["/trust", "Trust"],
  ["/system", "System"],
  ["/demo", "Demo"],
] as const;

export function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="shell">
      <aside>
        <p className="brand">Atlas</p>
        <p className="muted">Merchant evidence console</p>
        <nav>
          {NAV.map(([href, label]) => (
            <Link key={href} href={href}>
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="top">
          <h1>{title}</h1>
          <span className="badge" data-testid="test-mode-badge">
            RAZORPAY TEST MODE — SIMULATED
          </span>
        </header>
        <ClaimsBanner />
        {children}
      </div>
    </div>
  );
}
