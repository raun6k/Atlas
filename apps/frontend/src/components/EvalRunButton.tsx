"use client";

import { useState } from "react";

type Phase = "idle" | "running" | "done" | "error";

export function EvalRunButton({
  id,
  kind,
  label = "Run eval",
  prompt,
}: {
  id: string;
  kind: "deterministic" | "compatibility" | "commercial" | "custom";
  label?: string;
  prompt?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const slow = kind !== "deterministic";

  async function run() {
    setPhase("running");
    setDetail(slow ? "Running… this can take several minutes." : "Running contract eval…");
    try {
      const res = await fetch("/api/lab/eval", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ kind, prompt }),
        signal: AbortSignal.timeout(slow ? 280_000 : 100_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const summary =
        typeof body.summary === "string"
          ? body.summary
          : typeof body.message === "string"
            ? body.message
            : res.ok
              ? "Eval finished."
              : "Eval failed.";
      const error = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : null;
      const errorText = error && typeof error.message === "string" ? error.message : "";
      if (!res.ok) {
        setPhase("error");
        setDetail(errorText || summary);
        return;
      }
      setPhase("done");
      setDetail(summary);
    } catch (err) {
      setPhase("error");
      setDetail(err instanceof Error ? err.message : "Eval request failed.");
    }
  }

  return (
    <div className="eval-run">
      <button
        type="button"
        className="ticket-action"
        data-testid={`run-eval-${id}`}
        disabled={phase === "running"}
        onClick={() => void run()}
      >
        {phase === "running" ? "Running…" : label}
      </button>
      {detail ? (
        <p className={phase === "error" ? "eval-run-status is-error" : "eval-run-status"} data-testid={`eval-run-status-${id}`}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}
