import type { ReactNode } from "react";
import { headingize, humanize, idCol, looksLikeEnum, numericCol } from "@/lib/format";
import type { AuditProvenance, AuditState } from "@/lib/audit-view";

export function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function list(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>> : [];
}

export function evidenceClass(state: string): string {
  return `status status-${state.replace(/[\s-]/g, "_").toLowerCase()}`;
}

export function StatusMark({ state, label }: { state: string; label?: string }) {
  const normalized = state.replace(/[\s-]/g, "_").toLowerCase();
  return <span className={evidenceClass(normalized)}>{label ?? humanize(state)}</span>;
}

export function CodeChip({ value }: { value: string }) {
  if (!value) return null;
  return <code className="code-chip">{value}</code>;
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty-state table-empty">
      <p className="empty-title">{title}</p>
      {detail ? <p className="empty-detail">{detail}</p> : null}
    </div>
  );
}

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {hint ? <p className="muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function ToggleSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <details className="section toggle-section">
      <summary className="section-head">
        <h2>{title}</h2>
        {hint ? <p className="muted">{hint}</p> : null}
      </summary>
      {children}
    </details>
  );
}

export function provenanceLabel(value: AuditProvenance): string {
  return [
    value.source,
    value.report_id && `report ${value.report_id}`,
    value.run_id && `run ${value.run_id}`,
    value.content_digest && `digest ${value.content_digest.slice(0, 12)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function evidenceLabel(state: AuditState | string): string {
  const raw = state === "available" ? "measured" : String(state).replace(/_/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function Provenance({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <details className="provenance">
      <summary>Evidence source</summary>
      <p>{text}</p>
    </details>
  );
}

function tableCell(col: string, value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value);
  if (idCol(col) || col.endsWith("_id")) return <CodeChip value={text} />;
  if (looksLikeEnum(text)) {
    return (
      <span>
        {humanize(text)} <CodeChip value={text} />
      </span>
    );
  }
  return text;
}

export function DataTable({
  rows,
  cols,
  empty = "No rows yet.",
  emptyDetail = "Missing values stay blank. They are never shown as zero.",
}: {
  rows: Array<Record<string, unknown>>;
  cols: string[];
  empty?: string;
  emptyDetail?: string;
}) {
  if (!rows.length) return <EmptyState title={empty} detail={emptyDetail} />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className={numericCol(c) ? "num" : undefined}>
                {headingize(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 24).map((row, i) => (
            <tr key={String(row.id ?? row.merchant_order_id ?? row.session_id ?? row.product_id ?? i)}>
              {cols.map((c) => (
                <td
                  key={c}
                  className={[numericCol(c) ? "num" : "", idCol(c) ? "id" : ""].filter(Boolean).join(" ") || undefined}
                >
                  {tableCell(c, row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ArmTable({
  rows,
}: {
  rows: Array<{ label: string; control: string; treatment: string }>;
}) {
  return (
    <div className="table-wrap">
      <table className="arm-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>control</th>
            <th>treatment</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.control}</td>
              <td>{row.treatment}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function armValue(record: Record<string, unknown> | undefined, key: string): string {
  if (!record || record[key] === null || record[key] === undefined) return "—";
  return String(record[key]);
}

export function UpstreamNotice({ data }: { data: Record<string, unknown> }) {
  const err = rec(data.error);
  if (!err.state) return null;
  return (
    <div className="banner banner-warning" role="status">
      <strong>Upstream evidence unavailable</strong>
      <p>{String(err.message || "Values are not shown as zero.")}</p>
    </div>
  );
}
