export const STRATEGY_BLURBS: Record<string, string> = {
  FREE_DELIVERY: "Adding an item can unlock free delivery when the cart is under the fee threshold.",
  SMALL_ORDER: "A bounded top-up offer can avoid the small-order fee. Agents cannot invent a discount.",
  BRAND_PROMO: "Merchant-approved brand-funded offers only.",
  FBT: "Frequently-bought-together suggestions grounded in catalog pairing.",
  REORDER: "Buy-again suggestions from fixture purchase history.",
  REPLENISHMENT: "Running-low suggestions based on typical repurchase gaps.",
  PAST_PURCHASE: "Search ranking prefers products this buyer has bought before.",
  CART_COMPLETION: "Suggested add-ons commonly purchased with the current cart.",
  BASKET_REC: "Cart-relevant recommendations from the current basket.",
  SEARCH_RANKING: "Reorder search using preferences and the current query.",
  ROUTINE: "Items usually restocked together as a routine basket.",
  LARGER_PACK: "Switch to a larger pack when unit price is better.",
};

export function strategyBlurb(type: string): string {
  return STRATEGY_BLURBS[type] ?? "Merchant-controlled commercial strategy.";
}
