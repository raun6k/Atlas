package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/ids"
	"atlas.dev/core/internal/payment"
	"atlas.dev/core/internal/trust"

	"github.com/jackc/pgx/v5"
)

type ProposalView struct {
	ProposalID            string
	SessionID             string
	SessionContextVersion int64
	CartID                string
	CartVersion           int64
	QuoteHash             string
	FinalMinor            int64
	Currency              string
	Capability            string
	HoldExpiresAt         string
	ProposalExpiresAt     string
	Status                string
	Totals                TotalsView
	Lines                 []LineView
	LocationID            string
}

type OrderView struct {
	OrderID             string
	SessionID           string
	ProposalID          string
	Status              string
	TotalMinor          int64
	Currency            string
	PaymentAttemptID    string
	PaymentPublicStatus string
	LocationID          string
	CreatedAt           string
	OperationID         string
	Lines               []LineView
}

func (k *Kernel) PrepareCheckout(ctx context.Context, m Meta, sessionID, cartID string, expectedSession, expectedCart int64) (Envelope, SessionSummary, CartView, ProposalView, error) {
	if err := requireHost(m); err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	m.RequireIdempotency = true
	m.Tool = "prepare_checkout"
	if m.Arguments == nil {
		m.Arguments = map[string]any{"session_id": sessionID, "cart_id": cartID, "expected_session_context_version": expectedSession, "expected_cart_version": expectedCart}
	}
	tx, replay, op, err := k.beginMutation(ctx, m, "prepare_checkout", m.Arguments)
	if err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	if replay != nil {
		var out struct {
			Env Envelope
			S   SessionSummary
			C   CartView
			P   ProposalView
		}
		_ = json.Unmarshal(replay, &out)
		return out.Env, out.S, out.C, out.P, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	cv, err := k.loadCart(ctx, tx, s.CartID)
	if err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	if err := k.guardMutable(s); err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	if err := k.expectSession(s, expectedSession); err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, wrapConflict(err, s, cv)
	}
	if err := k.expectCart(s, expectedCart); err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, wrapConflict(err, s, cv)
	}
	if cartID != "" && s.CartID != cartID {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, apperr.New(apperr.InvalidArgument, "cart does not belong to session")
	}
	if len(cv.Lines) == 0 {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, apperr.New(apperr.InvalidArgument, "cart is empty")
	}
	if err := k.invalidateActiveProposal(ctx, tx, &s); err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	cv, err = k.recalcAndStoreCart(ctx, tx, s)
	if err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	for _, line := range cv.Lines {
		_, _, price, sellable, err := k.skuPriceQty(ctx, tx, s.LocationID, line.SKUID)
		if err != nil {
			return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
		}
		if price != line.UnitMinor {
			return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, apperr.New(apperr.RequoteRequired, "price changed before checkout")
		}
		if int(line.Quantity) > sellable {
			return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, apperr.New(apperr.InventoryChanged, "insufficient inventory for atomic hold")
		}
	}
	fees, ferr := k.locationFees(ctx, tx, s.LocationID)
	if ferr != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, ferr
	}
	if fees.MinimumOrderValueMinor > 0 && cv.Totals.MerchandiseMinor-cv.Totals.DiscountsMinor < fees.MinimumOrderValueMinor {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, apperr.New(apperr.MerchantPolicyDenied, "cart is below the minimum order value")
	}
	pid := ids.New(ids.Proposal)
	holdExp := k.Now().Add(k.Cfg.ProposalHoldTTL)
	snap, _ := json.Marshal(map[string]any{"lines": cv.Lines, "totals": cv.Totals})
	qh := quoteHash(cv)
	if _, err := tx.Exec(ctx, `
		INSERT INTO checkout_proposals (checkout_proposal_id, session_id, cart_id, session_context_version, cart_version, location_id, quote_hash, currency,
			merchandise_minor, discounts_minor, delivery_fee_minor, handling_fee_minor, tax_minor, final_amount_minor, payment_capability_id, snapshot, status, hold_expires_at, proposal_expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'INR',$8,$9,$10,$11,$12,$13,'pcap_razorpay_test',$14,'ACTIVE',$15,$15)`,
		pid, s.SessionID, s.CartID, s.SessionContextVersion, s.CartVersion, s.LocationID, qh,
		cv.Totals.MerchandiseMinor, cv.Totals.DiscountsMinor, cv.Totals.DeliveryFeeMinor, cv.Totals.HandlingFeeMinor, cv.Totals.TaxMinor, cv.Totals.AllInMinor,
		snap, holdExp); err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE shopping_sessions SET status='CHECKOUT_HELD', updated_at=now() WHERE session_id=$1`, s.SessionID); err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	s.Status = "CHECKOUT_HELD"
	prop := ProposalView{
		ProposalID: pid, SessionID: s.SessionID, SessionContextVersion: s.SessionContextVersion, CartID: s.CartID, CartVersion: s.CartVersion,
		QuoteHash: qh, FinalMinor: cv.Totals.AllInMinor, Currency: "INR", Capability: "pcap_razorpay_test",
		HoldExpiresAt: holdExp.Format("2006-01-02T15:04:05Z"), ProposalExpiresAt: holdExp.Format("2006-01-02T15:04:05Z"),
		Status: "ACTIVE", Totals: cv.Totals, Lines: cv.Lines, LocationID: s.LocationID,
	}
	env := k.withRequest(k.env(), m.RequestID, op)
	aid, err := auditMutation(ctx, tx, m, op, "prepare_checkout", "checkout_proposal", pid, s.CartVersion, map[string]any{"quote_hash": qh, "amount_minor": cv.Totals.AllInMinor}, "Approved Host prepared checkout after Atlas verified every line is in stock.")
	if err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	payload := struct {
		Env Envelope
		S   SessionSummary
		C   CartView
		P   ProposalView
	}{env, s, cv, prop}
	if err := k.storeIdempotency(ctx, tx, m, "prepare_checkout", m.Arguments, payload, aid); err != nil {
		return Envelope{}, SessionSummary{}, CartView{}, ProposalView{}, err
	}
	return env, s, cv, prop, tx.Commit(ctx)
}

func quoteHash(cv CartView) string {
	b, _ := json.Marshal(struct {
		Lines  []LineView
		Totals TotalsView
	}{cv.Lines, cv.Totals})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (k *Kernel) CompleteCheckout(ctx context.Context, m Meta, sessionID, proposalID, authority string) (Envelope, OrderView, error) {
	if err := requireHost(m); err != nil {
		return Envelope{}, OrderView{}, err
	}
	m.RequireIdempotency = true
	m.Tool = "complete_checkout"
	if m.Arguments == nil {
		m.Arguments = map[string]any{"session_id": sessionID, "checkout_proposal_id": proposalID}
	}
	tx, replay, op, err := k.beginMutation(ctx, m, "complete_checkout", m.Arguments)
	if err != nil {
		return Envelope{}, OrderView{}, err
	}
	if replay != nil {
		var out struct {
			Env Envelope
			O   OrderView
		}
		_ = json.Unmarshal(replay, &out)
		return out.Env, out.O, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := k.loadSession(ctx, tx, sessionID, m.ApprovedHostID)
	if err != nil {
		return Envelope{}, OrderView{}, err
	}
	var quoteHash, status, loc string
	var amount int64
	var scv, cv int64
	var holdExp time.Time
	err = tx.QueryRow(ctx, `
		SELECT quote_hash, status, final_amount_minor, location_id, session_context_version, cart_version, hold_expires_at
		FROM checkout_proposals WHERE checkout_proposal_id=$1 AND session_id=$2 FOR UPDATE`, proposalID, sessionID).
		Scan(&quoteHash, &status, &amount, &loc, &scv, &cv, &holdExp)
	if errors.Is(err, pgx.ErrNoRows) {
		return Envelope{}, OrderView{}, apperr.New(apperr.NotFound, "checkout proposal not found")
	}
	if err != nil {
		return Envelope{}, OrderView{}, err
	}
	if status != "ACTIVE" {
		return Envelope{}, OrderView{}, apperr.New(apperr.RequoteRequired, "proposal is not active")
	}
	if k.Now().After(holdExp) {
		_ = k.releaseProposal(ctx, tx, proposalID, "EXPIRED")
		return Envelope{}, OrderView{}, apperr.New(apperr.RequoteRequired, "proposal expired")
	}
	auth, err := trust.VerifyCheckoutAuthority(ctx, tx, authority, m.ApprovedHostID, proposalID, quoteHash, "pcap_razorpay_test", amount, "INR", k.Now(), k.Cfg.HostAudience, k.Cfg.CheckoutAuthorityTTL)
	if err != nil {
		k.recordGateDecision(ctx, m, op, sessionID, proposalID, "DENY", gateReasonCodes(err), "Atlas denied complete checkout because checkout authority did not verify.")
		return Envelope{}, OrderView{}, err
	}
	_ = auth
	polID, err := insertAllowPolicy(ctx, tx, m, op, sessionID, proposalID, quoteHash, []string{
		"HOST_ACTIVE", "PROOF_VALID", "AUTHORITY_VALID", "AMOUNT_BOUND", "CAPABILITY_TEST", "TRUST_GATE_ALLOW",
	})
	if err != nil {
		return Envelope{}, OrderView{}, err
	}
	passID := ids.New(ids.Passport)
	passExp := k.Now().Add(k.Cfg.CheckoutAuthorityTTL)
	if _, err := tx.Exec(ctx, `INSERT INTO execution_passports (passport_id, checkout_proposal_id, policy_decision_id, action_type, action_digest, amount_minor, currency, payment_capability_id, authority_hash, expires_at) VALUES ($1,$2,$3,'COMPLETE_CHECKOUT',$4,$5,'INR','pcap_razorpay_test',$6,$7)`,
		passID, proposalID, polID, quoteHash, amount, trust.ArtifactDigest(authority), passExp); err != nil {
		return Envelope{}, OrderView{}, err
	}
	orderID := ids.New(ids.Order)
	payID := ids.New(ids.Payment)
	if _, err := tx.Exec(ctx, `UPDATE checkout_proposals SET status='CONSUMED' WHERE checkout_proposal_id=$1`, proposalID); err != nil {
		return Envelope{}, OrderView{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE shopping_sessions SET status='PAYMENT_PENDING', updated_at=now() WHERE session_id=$1`, sessionID); err != nil {
		return Envelope{}, OrderView{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO orders (order_id, checkout_proposal_id, session_id, location_id, status, currency, total_amount_minor, quote_hash, payment_attempt_id, payment_public_status, snapshot)
		VALUES ($1,$2,$3,$4,'PENDING_PAYMENT','INR',$5,$6,$7,'PAYMENT_PROCESSING','{}')`,
		orderID, proposalID, sessionID, loc, amount, quoteHash, payID); err != nil {
		return Envelope{}, OrderView{}, err
	}
	cvw, _ := k.loadCart(ctx, tx, s.CartID)
	for _, line := range cvw.Lines {
		if _, err := tx.Exec(ctx, `INSERT INTO order_lines (order_line_id, order_id, sku_id, product_id, quantity, unit_amount_minor, line_total_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			ids.New(ids.OrderLine), orderID, line.SKUID, line.ProductID, line.Quantity, line.UnitMinor, line.LineMinor); err != nil {
			return Envelope{}, OrderView{}, err
		}
	}
	if err := payment.Current().AfterPendingOrder(payment.WithExistingTx(ctx, tx), payment.PendingOrder{
		OrderID: orderID, PaymentAttemptID: payID, ProposalID: proposalID, AmountMinor: amount, Currency: "INR",
		OperationID: op, PassportID: passID, HostID: m.ApprovedHostID, IdempotencyKey: m.IdempotencyKey,
		RequestID: m.RequestID, SessionID: sessionID, LocationID: loc, QuoteHash: quoteHash,
	}); err != nil {
		return Envelope{}, OrderView{}, err
	}
	ov := OrderView{
		OrderID: orderID, SessionID: sessionID, ProposalID: proposalID, Status: "PENDING_PAYMENT", TotalMinor: amount, Currency: "INR",
		PaymentAttemptID: payID, PaymentPublicStatus: "PAYMENT_PROCESSING", LocationID: loc, CreatedAt: k.Now().Format("2006-01-02T15:04:05Z"),
		OperationID: op, Lines: cvw.Lines,
	}
	env := k.withRequest(k.env(), m.RequestID, op)
	env.OperationID = op
	aid, err := auditMutation(ctx, tx, m, op, "complete_checkout", "order", orderID, 0, map[string]any{
		"effect_disposition": "EXTERNAL_ACTION_SCHEDULED", "passport_id": passID, "verification": "PASS",
	}, "Approved Host submitted complete checkout. Atlas allowed it and created a pending Test Mode order. Provider capture is not claimed.")
	if err != nil {
		return Envelope{}, OrderView{}, err
	}
	payload := struct {
		Env Envelope
		O   OrderView
	}{env, ov}
	if err := k.storeIdempotency(ctx, tx, m, "complete_checkout", m.Arguments, payload, aid); err != nil {
		return Envelope{}, OrderView{}, err
	}
	return env, ov, tx.Commit(ctx)
}

func (k *Kernel) GetOrder(ctx context.Context, m Meta, sessionID, orderID string) (Envelope, OrderView, error) {
	if err := requireHost(m); err != nil {
		return Envelope{}, OrderView{}, err
	}
	var ov OrderView
	var created time.Time
	err := k.Pool().QueryRow(ctx, `
		SELECT order_id, session_id, COALESCE(checkout_proposal_id,''), status, total_amount_minor, currency, COALESCE(payment_attempt_id,''), COALESCE(payment_public_status,''), location_id, created_at
		FROM orders WHERE order_id=$1`, orderID).Scan(
		&ov.OrderID, &ov.SessionID, &ov.ProposalID, &ov.Status, &ov.TotalMinor, &ov.Currency, &ov.PaymentAttemptID, &ov.PaymentPublicStatus, &ov.LocationID, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return Envelope{}, OrderView{}, apperr.New(apperr.NotFound, "order not found")
	}
	if err != nil {
		return Envelope{}, OrderView{}, err
	}
	if sessionID != "" && ov.SessionID != sessionID {
		return Envelope{}, OrderView{}, apperr.New(apperr.HostForbidden, "order does not belong to session")
	}
	if m.ApprovedHostID != "" {
		var host string
		if err := k.Pool().QueryRow(ctx, `SELECT approved_host_id FROM shopping_sessions WHERE session_id=$1`, ov.SessionID).Scan(&host); err != nil {
			return Envelope{}, OrderView{}, err
		}
		if host != m.ApprovedHostID {
			return Envelope{}, OrderView{}, apperr.New(apperr.HostForbidden, "order does not belong to this host")
		}
	}
	ov.CreatedAt = created.UTC().Format(time.RFC3339)
	rows, err := k.Pool().Query(ctx, `SELECT sku_id, product_id, quantity, unit_amount_minor, line_total_minor FROM order_lines WHERE order_id=$1`, orderID)
	if err != nil {
		return Envelope{}, OrderView{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var l LineView
		if err := rows.Scan(&l.SKUID, &l.ProductID, &l.Quantity, &l.UnitMinor, &l.LineMinor); err != nil {
			return Envelope{}, OrderView{}, err
		}
		ov.Lines = append(ov.Lines, l)
	}
	return k.withRequest(k.env(), m.RequestID, ""), ov, nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
