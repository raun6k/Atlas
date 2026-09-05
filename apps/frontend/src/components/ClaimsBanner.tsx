import { CLAIM_BANNER } from "@/lib/claims";

export function ClaimsBanner() {
  return (
    <p className="claim" data-testid="claim-banner">
      {CLAIM_BANNER}
    </p>
  );
}
