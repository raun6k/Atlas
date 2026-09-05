package commerce

type RuntimeEconomics struct {
	SourcePromotionID         string
	DiscountAmountMinor       int64
	MerchantFundedMinor       int64
	PartnerFundedMinor        int64
	ExpectedMarginImpactMinor int64
	QuoteDeltaMinor           int64
	EligibilityInputs         map[string]any
}

type PublicExplanation struct {
	WhatChanged         string `json:"what_changed"`
	WhyEligible         string `json:"why_eligible"`
	BuyerCostDeltaMinor int64  `json:"buyer_cost_delta_minor"`
	BuyerSaveMinor      int64  `json:"buyer_save_minor"`
	DeliveryChange      string `json:"delivery_change"`
	QuantityChange      string `json:"quantity_change"`
	FundedBy            string `json:"funded_by"`
}

func ExplainCandidate(c Candidate) PublicExplanation {
	qty := ""
	if len(c.Patch.Lines) > 0 {
		qty = "quantity " + itoa(c.Patch.Lines[0].Quantity) + " of listed SKU"
	}
	save := int64(0)
	if c.BuyerImpact < 0 {
		save = -c.BuyerImpact
	}
	econ := c.Economics
	funded := "listed catalog price; no extra discount"
	if econ.DiscountAmountMinor > 0 {
		if econ.PartnerFundedMinor > 0 && econ.MerchantFundedMinor > 0 {
			funded = "split between brand and merchant"
		} else if econ.PartnerFundedMinor > 0 {
			funded = "brand-funded"
		} else {
			funded = "merchant-funded"
		}
	}
	delivery := "delivery fee unchanged"
	if c.Patch.Economics != nil && c.Patch.Economics.FeeSavingMinor > 0 {
		delivery = "delivery or small-order fee reduced if the threshold is met"
	}
	what := c.Terms
	if what == "" {
		what = c.Strategy
	}
	why := c.Reason
	if why == "" {
		why = c.Eligibility
	}
	return PublicExplanation{
		WhatChanged:         what,
		WhyEligible:         why,
		BuyerCostDeltaMinor: c.BuyerImpact,
		BuyerSaveMinor:      save,
		DeliveryChange:      delivery,
		QuantityChange:      qty,
		FundedBy:            funded,
	}
}

func AttachEconomics(c *Candidate, sim SimulatedCandidate, in Inputs) {
	c.BuyerImpact = sim.BuyerImpact
	c.BaseAllInMinor = sim.BaseAllInMinor
	c.PatchedAllIn = sim.PatchedAllInMinor
	c.Eligibility = sim.Eligibility
	econ := RuntimeEconomics{
		SourcePromotionID:   c.Patch.PromotionID,
		QuoteDeltaMinor:     sim.PatchedAllInMinor - sim.BaseAllInMinor,
		DiscountAmountMinor: sim.DiscountDeltaMinor,
		EligibilityInputs: map[string]any{
			"strategy": c.Strategy, "eligibility": sim.Eligibility,
			"base_all_in_minor": sim.BaseAllInMinor, "patched_all_in_minor": sim.PatchedAllInMinor,
		},
	}
	if sim.ContributionDeltaMinor != nil {
		econ.ExpectedMarginImpactMinor = *sim.ContributionDeltaMinor
	}
	if c.Patch.PromotionID != "" {
		terms := in.PromoTerms[c.Patch.PromotionID]
		brand, merchant := SplitFunding(econ.DiscountAmountMinor, terms.BrandFundPct, terms.MerchantFundPct)
		econ.PartnerFundedMinor = brand
		econ.MerchantFundedMinor = merchant
		econ.EligibilityInputs["promotion_id"] = c.Patch.PromotionID
		econ.EligibilityInputs["discount_cap_minor"] = terms.DiscountCap
		econ.EligibilityInputs["minimum_spend_minor"] = terms.MinimumSpend
	}
	c.Economics = econ
	c.Explanation = ExplainCandidate(*c)
}
