package commerce

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// BuyerCopy is the merchant-editable text shown to the Buyer Agent.
// Edit `buyer` on each row in strategies.json. Placeholders use {{name}}.
type BuyerCopy struct {
	Headline string `json:"headline"`
	Reason   string `json:"reason"`
	Terms    string `json:"terms"`
	CTA      string `json:"cta,omitempty"`
}

var templateVar = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_]+)\s*\}\}`)

func INR(minor int64) string {
	if minor%100 == 0 {
		return fmt.Sprintf("₹%d", minor/100)
	}
	return fmt.Sprintf("₹%.2f", float64(minor)/100.0)
}

func RenderTemplate(tmpl string, vars map[string]string) string {
	if tmpl == "" {
		return ""
	}
	return templateVar.ReplaceAllStringFunc(tmpl, func(m string) string {
		name := strings.TrimSpace(m[2 : len(m)-2])
		if vars == nil {
			return ""
		}
		return vars[name]
	})
}

func BuyerCopyFromConfig(raw []byte) BuyerCopy {
	if len(raw) == 0 {
		return BuyerCopy{}
	}
	var wrap struct {
		Buyer BuyerCopy `json:"buyer"`
	}
	_ = json.Unmarshal(raw, &wrap)
	return wrap.Buyer
}

func itoa(n int) string { return strconv.Itoa(n) }

func fmtDays(d float64) string {
	if d < 0 {
		d = 0
	}
	return strconv.Itoa(int(d + 0.5))
}

func fmtPct(p float64) string {
	if p < 0 {
		p = 0
	}
	return strconv.Itoa(int(p*100+0.5)) + "%"
}

func skuVars(sku CatalogSKU, qty int) map[string]string {
	if qty < 1 {
		qty = 1
	}
	return map[string]string{
		"sku_name": sku.Name,
		"sku_id":   sku.SKUID,
		"quantity": strconv.Itoa(qty),
		"price":    INR(sku.SellingMinor),
		"brand":    sku.Brand,
	}
}

func mergeVars(base, extra map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func applyBuyerCopy(c *Candidate, in Inputs) {
	if c.Vars == nil {
		c.Vars = map[string]string{}
	}
	c.Vars["buyer_impact"] = INR(c.BuyerImpact)
	copy := DefaultBuyerCopy[c.Strategy]
	if in.Copy != nil {
		if override, ok := in.Copy[c.Strategy]; ok {
			copy = mergeCopy(copy, override)
		}
	}
	if rendered := RenderTemplate(copy.Reason, c.Vars); rendered != "" {
		c.Reason = rendered
	}
	headline := RenderTemplate(copy.Headline, c.Vars)
	terms := RenderTemplate(copy.Terms, c.Vars)
	if headline != "" {
		c.Terms = headline
	} else if terms != "" {
		c.Terms = terms
	}
	if headline != "" && terms != "" && terms != headline {
		if c.Reason == "" {
			c.Reason = terms
		}
	}
}

func mergeCopy(base, over BuyerCopy) BuyerCopy {
	if over.Headline != "" {
		base.Headline = over.Headline
	}
	if over.Reason != "" {
		base.Reason = over.Reason
	}
	if over.Terms != "" {
		base.Terms = over.Terms
	}
	if over.CTA != "" {
		base.CTA = over.CTA
	}
	return base
}

// DefaultBuyerCopy is used when strategies.json omits a buyer block.
var DefaultBuyerCopy = map[string]BuyerCopy{
	"REORDER": {
		Headline: "Buy again",
		Reason:   "Add {{sku_name}} — you usually repurchase this about every {{median_days}} days.",
		Terms:    "Buy again · qty {{quantity}}",
	},
	"REPLENISHMENT": {
		Headline: "Running low",
		Reason:   "{{sku_name}} looks due. Last bought {{days_since}} days ago (typical gap {{median_days}} days).",
		Terms:    "Replenish · qty {{quantity}}",
	},
	"CART_COMPLETION": {
		Headline: "Complete this shop",
		Reason:   "{{sku_name}} is often missing from baskets like yours.",
		Terms:    "Suggested add-on",
	},
	"BASKET_REC": {
		Headline: "Goes with your cart",
		Reason:   "{{sku_name}} is a relevant add for what you already picked.",
		Terms:    "Cart recommendation",
	},
	"FBT": {
		Headline: "Frequently bought together",
		Reason:   "Shoppers who buy {{anchor_name}} often add {{sku_name}}.",
		Terms:    "Often paired",
	},
	"ROUTINE": {
		Headline: "{{routine_name}}",
		Reason:   "Restock {{routine_name}} (every {{cadence_days}} days). Adds {{item_count}} usual items, starting with {{sku_name}}.",
		Terms:    "Routine basket",
	},
	"LARGER_PACK": {
		Headline: "Better unit price",
		Reason:   "Switch {{current_name}} to {{sku_name}} to save {{saving_pct}} on unit price.",
		Terms:    "Larger pack",
	},
	"FREE_DELIVERY": {
		Headline: "Unlock free delivery",
		Reason:   "Add {{sku_name}} ({{price}}). You are {{gap}} short of free delivery, and this avoids a {{fee_saving}} fee.",
		Terms:    "Free delivery top-up",
	},
	"SMALL_ORDER": {
		Headline: "Avoid the small-order fee",
		Reason:   "Add {{sku_name}} ({{price}}). You are {{gap}} under the small-order threshold; this avoids a {{fee_saving}} fee.",
		Terms:    "Small-order top-up",
	},
	"BRAND_PROMO": {
		Headline: "{{promo_name}}",
		Reason:   "{{promo_name}} on {{sku_name}} — {{discount}} off with brand-funded support.",
		Terms:    "Brand offer",
	},
	"PAST_PURCHASE": {
		Headline: "Your usual pick",
		Reason:   "Prefer products you have bought before when ranking search.",
		Terms:    "History boost",
	},
	"SEARCH_RANKING": {
		Headline: "Personalized ranking",
		Reason:   "Reorder search using your preferences and this query.",
		Terms:    "Personalized search",
	},
}
