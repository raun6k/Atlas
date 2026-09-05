import { Shell } from "@/components/Shell";
import { Dashboard } from "@/components/Dashboard";
import { loadDashboard } from "@/lib/console";
import { rec } from "@/components/ui";
import type { AuditView } from "@/lib/audit-view";

export async function ConsolePage() {
  const data = await loadDashboard();
  const merchant =
    data.audit_view && typeof data.audit_view === "object" ? (data.audit_view as AuditView).merchant : undefined;
  const profile = merchant?.profile.value;
  const merchantName = profile ? String(profile.display_name ?? "QuickMart") : "QuickMart";
  return (
    <Shell title="Dashboard" fixture={data.mock === true} merchantName={merchantName} merchantDetail={String(rec(profile).currency || "INR")}>
      <Dashboard data={data} />
    </Shell>
  );
}
