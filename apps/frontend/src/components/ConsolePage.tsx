import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ScreenView } from "@/components/ScreenView";
import { loadScreen, type Screen } from "@/lib/console";
import { readSession } from "@/lib/session";

const TITLES: Record<Screen, string> = {
  home: "Home",
  sellability: "Sellability",
  growth: "Growth",
  commerce: "Commerce",
  merchant: "Merchant",
  trust: "Trust",
  system: "System",
  demo: "Five-minute demo",
};

export async function ConsolePage({ screen }: { screen: Screen }) {
  const session = await readSession();
  if (!session) redirect("/login");
  const data = await loadScreen(screen);
  return (
    <Shell title={TITLES[screen]}>
      <ScreenView screen={screen} data={data} />
    </Shell>
  );
}
