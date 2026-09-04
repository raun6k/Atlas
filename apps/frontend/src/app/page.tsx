export default function HomePage() {
  return (
    <main>
      <div className="panel">
        <span className="badge" data-testid="test-mode-badge">
          RAZORPAY TEST MODE — SIMULATED
        </span>
        <h1>Atlas operator console</h1>
        <p>
          This process slot is reserved. The previous console UI has been cleared for a rebuild.
          Health endpoints remain at <code>/health/live</code> and <code>/health/ready</code>.
        </p>
      </div>
    </main>
  );
}
