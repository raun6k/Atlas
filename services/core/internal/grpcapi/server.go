package grpcapi

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/apperr"
	"atlas.dev/core/internal/commerce"
	v1 "atlas.dev/core/internal/gen/atlas/merchant/v1"
	"atlas.dev/core/internal/payment"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type Server struct {
	v1.UnimplementedMerchantQueryServiceServer
	v1.UnimplementedSessionServiceServer
	v1.UnimplementedCartServiceServer
	v1.UnimplementedCheckoutServiceServer
	v1.UnimplementedFulfillmentServiceServer
	v1.UnimplementedPaymentFabricServiceServer
	v1.UnimplementedFixtureServiceServer
	v1.UnimplementedAdminServiceServer
	v1.UnimplementedAuditServiceServer
	v1.UnimplementedWorkerServiceServer
	K   *app.Kernel
	Pay *payment.Service
}

func Register(g *grpc.Server, k *app.Kernel, pay *payment.Service) {
	s := &Server{K: k, Pay: pay}
	v1.RegisterMerchantQueryServiceServer(g, s)
	v1.RegisterSessionServiceServer(g, s)
	v1.RegisterCartServiceServer(g, s)
	v1.RegisterCheckoutServiceServer(g, s)
	v1.RegisterFulfillmentServiceServer(g, s)
	v1.RegisterPaymentFabricServiceServer(g, s)
	v1.RegisterFixtureServiceServer(g, s)
	v1.RegisterAdminServiceServer(g, s)
	v1.RegisterAuditServiceServer(g, s)
	v1.RegisterWorkerServiceServer(g, s)
}

func meta(ctx context.Context, m *v1.RequestMeta) app.Meta {
	var out app.Meta
	if m != nil {
		out = app.Meta{
			RequestID:        m.RequestId,
			IdempotencyKey:   m.IdempotencyKey,
			HostRequestProof: m.HostRequestProof,
			Correlation:      m.Correlation,
		}
	}
	if id := IdentityFrom(ctx); id != nil {
		if id.HostID != "" {
			out.ApprovedHostID = id.HostID
		}
		out.OperatorID = id.OperatorID
		out.OperatorScopes = append([]string(nil), id.OperatorScopes...)
	}
	return out
}

func (s *Server) GetCapabilities(ctx context.Context, in *v1.GetCapabilitiesRequest) (*v1.GetCapabilitiesResponse, error) {
	env, cap, err := s.K.GetCapabilities(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetCapabilitiesResponse{Envelope: toEnv(env), Capabilities: &v1.Capabilities{
		ContractFamily: cap.ContractFamily, ContractVersion: cap.ContractVersion, MerchantDisplayName: cap.MerchantDisplayName,
		Currency: cap.Currency, Locale: cap.Locale, Tools: cap.Tools, MaxPageSize: cap.MaxPageSize,
		OfferTtlSeconds: cap.OfferTTLSeconds, ProposalHoldTtlSeconds: cap.ProposalHoldTTLSeconds,
		Payment: &v1.PaymentCapability{
			CapabilityId: cap.PaymentCapabilityID, Provider: "razorpay", Environment: "test", MoneyMovement: "simulated",
			CompletionMode: "asynchronous", RequiresCheckoutProposal: true, RequiresCheckoutAuthority: true,
			SupportsBuyerAgentRawInstrumentAccess: false, TerminalSuccessState: "CAPTURED_RECONCILED",
			Status: cap.PaymentStatus,
		},
	}}, nil
}

func (s *Server) GetProfile(ctx context.Context, in *v1.GetProfileRequest) (*v1.GetProfileResponse, error) {
	return s.GetMerchantProfile(ctx, in)
}

func (s *Server) SearchCatalog(ctx context.Context, in *v1.SearchCatalogRequest) (*v1.SearchCatalogResponse, error) {
	m := meta(ctx, in.Meta)
	env, items, cursor, offers, err := s.K.SearchCatalog(ctx, m, in.SessionId, in.Query, in.Category, in.Brand, in.Cursor, in.PageSize)
	if err != nil {
		return nil, toStatus(err)
	}
	cur := s.displayCurrency(ctx)
	out := &v1.SearchCatalogResponse{Envelope: toEnv(env), NextCursor: cursor, Offers: toOffers(offers, cur)}
	for _, it := range items {
		out.Items = append(out.Items, toSKU(it, cur))
	}
	return out, nil
}

func (s *Server) GetProduct(ctx context.Context, in *v1.GetProductRequest) (*v1.GetProductResponse, error) {
	env, p, err := s.K.GetProduct(ctx, meta(ctx, in.Meta), in.SessionId, in.ProductId, in.LocationId)
	if err != nil {
		return nil, toStatus(err)
	}
	prod := &v1.Product{ProductId: p.ProductID, Name: p.Name, Brand: p.Brand, Category: p.Category, Subcategory: p.Subcategory, CanonicalDescription: p.Description, Dietary: p.Dietary, Lifecycle: p.Lifecycle}
	cur := s.displayCurrency(ctx)
	for _, sku := range p.SKUs {
		prod.Skus = append(prod.Skus, toSKU(sku, cur))
	}
	return &v1.GetProductResponse{Envelope: toEnv(env), Product: prod}, nil
}

func (s *Server) CreateSession(ctx context.Context, in *v1.CreateSessionRequest) (*v1.CreateSessionResponse, error) {
	m := meta(ctx, in.Meta)
	allowlist := in.GetStrategyAllowlist()
	if allowlist == nil {
		allowlist = []string{}
	}
	m.Arguments = map[string]any{"subject_reference": in.SubjectReference, "delivery_serviceability_reference": in.DeliveryServiceabilityReference, "locale": in.Locale, "requested_location_id": in.RequestedLocationId, "strategy_allowlist": allowlist}
	if in.EvaluationArm != "" {
		m.Arguments["evaluation_arm"] = in.EvaluationArm
	}
	out, err := s.K.CreateSession(ctx, m, in.SubjectReference, in.DeliveryServiceabilityReference, in.Locale, in.RequestedLocationId, in.EvaluationArm, allowlist)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CreateSessionResponse{Envelope: toEnv(out.Envelope), SessionSummary: toSession(out.Session), Cart: toCart(out.Cart), Offers: toOffers(out.Offers, out.Session.Currency), TreatmentPolicy: toPolicy(out.Session.Treatment)}, nil
}

func (s *Server) SetIntent(ctx context.Context, in *v1.SetIntentRequest) (*v1.SetIntentResponse, error) {
	m := meta(ctx, in.Meta)
	constraints := in.Constraints
	if constraints == nil {
		constraints = map[string]string{}
	}
	m.Arguments = map[string]any{"session_id": in.SessionId, "expected_session_context_version": in.ExpectedSessionContextVersion, "mission": in.Mission, "planning_budget_minor": in.PlanningBudgetMinor, "currency": in.Currency, "constraints": constraints}
	out, err := s.K.SetIntent(ctx, m, in.SessionId, in.ExpectedSessionContextVersion, in.Mission, in.PlanningBudgetMinor, in.Currency, constraints)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.SetIntentResponse{Envelope: toEnv(out.Envelope), SessionSummary: toSession(out.Session), Cart: toCart(out.Cart), Offers: toOffers(out.Offers, out.Session.Currency), InvalidatedOfferIds: out.InvalidatedOfferIDs, TreatmentPolicy: toPolicy(out.Session.Treatment)}, nil
}

func (s *Server) GetSession(ctx context.Context, in *v1.GetSessionRequest) (*v1.GetSessionResponse, error) {
	env, sess, cart, err := s.K.GetSession(ctx, meta(ctx, in.Meta), in.SessionId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetSessionResponse{Envelope: toEnv(env), SessionSummary: toSession(sess), Cart: toCart(cart), SubjectReference: sess.SubjectReference, HostId: sess.HostID, TreatmentPolicy: toPolicy(sess.Treatment)}, nil
}

func (s *Server) GetCart(ctx context.Context, in *v1.GetCartRequest) (*v1.GetCartResponse, error) {
	out, err := s.K.GetCart(ctx, meta(ctx, in.Meta), in.SessionId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetCartResponse{Envelope: toEnv(out.Envelope), SessionSummary: toSession(out.Session), Cart: toCart(out.Cart), Offers: toOffers(out.Offers, out.Session.Currency), TreatmentPolicy: toPolicy(out.Session.Treatment)}, nil
}

func (s *Server) AddItem(ctx context.Context, in *v1.AddItemRequest) (*v1.CartMutationResult, error) {
	m := meta(ctx, in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "cart_id": in.CartId, "expected_cart_version": in.ExpectedCartVersion, "sku_id": in.SkuId, "quantity": in.Quantity}
	out, err := s.K.AddItem(ctx, m, in.SessionId, in.CartId, in.ExpectedCartVersion, in.SkuId, in.Quantity)
	if err != nil {
		return nil, toStatus(err)
	}
	return toMut(out), nil
}

func (s *Server) UpdateItem(ctx context.Context, in *v1.UpdateItemRequest) (*v1.CartMutationResult, error) {
	m := meta(ctx, in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "cart_id": in.CartId, "expected_cart_version": in.ExpectedCartVersion, "cart_line_id": in.CartLineId, "quantity": in.Quantity}
	out, err := s.K.UpdateItem(ctx, m, in.SessionId, in.CartId, in.ExpectedCartVersion, in.CartLineId, in.Quantity)
	if err != nil {
		return nil, toStatus(err)
	}
	return toMut(out), nil
}

func (s *Server) RemoveItem(ctx context.Context, in *v1.RemoveItemRequest) (*v1.CartMutationResult, error) {
	m := meta(ctx, in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "cart_id": in.CartId, "expected_cart_version": in.ExpectedCartVersion, "cart_line_id": in.CartLineId}
	out, err := s.K.RemoveItem(ctx, m, in.SessionId, in.CartId, in.ExpectedCartVersion, in.CartLineId)
	if err != nil {
		return nil, toStatus(err)
	}
	return toMut(out), nil
}

func (s *Server) ApplyOffer(ctx context.Context, in *v1.ApplyOfferRequest) (*v1.CartMutationResult, error) {
	m := meta(ctx, in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "offer_id": in.OfferId, "expected_session_context_version": in.ExpectedSessionContextVersion, "expected_cart_version": in.ExpectedCartVersion}
	out, err := s.K.ApplyOffer(ctx, m, in.SessionId, in.OfferId, in.ExpectedSessionContextVersion, in.ExpectedCartVersion)
	if err != nil {
		return nil, toStatus(err)
	}
	return toMut(out), nil
}

func (s *Server) PrepareCheckout(ctx context.Context, in *v1.PrepareCheckoutRequest) (*v1.PrepareCheckoutResponse, error) {
	m := meta(ctx, in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "cart_id": in.CartId, "expected_session_context_version": in.ExpectedSessionContextVersion, "expected_cart_version": in.ExpectedCartVersion}
	env, sess, cart, prop, err := s.K.PrepareCheckout(ctx, m, in.SessionId, in.CartId, in.ExpectedSessionContextVersion, in.ExpectedCartVersion)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.PrepareCheckoutResponse{Envelope: toEnv(env), SessionSummary: toSession(sess), Cart: toCart(cart), Proposal: toProposal(prop)}, nil
}

func (s *Server) CompleteCheckout(ctx context.Context, in *v1.CompleteCheckoutRequest) (*v1.CompleteCheckoutResponse, error) {
	m := meta(ctx, in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "checkout_proposal_id": in.CheckoutProposalId}
	env, ord, err := s.K.CompleteCheckout(ctx, m, in.SessionId, in.CheckoutProposalId, in.CheckoutAuthority)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CompleteCheckoutResponse{Envelope: toEnv(env), MerchantOrderId: ord.OrderID, PaymentAttemptId: ord.PaymentAttemptID, OperationId: env.OperationID, PublicStatus: "PAYMENT_PROCESSING", Order: toOrder(ord)}, nil
}

func (s *Server) GetOrder(ctx context.Context, in *v1.GetOrderRequest) (*v1.GetOrderResponse, error) {
	env, ord, err := s.K.GetOrder(ctx, meta(ctx, in.Meta), in.SessionId, in.MerchantOrderId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetOrderResponse{Envelope: toEnv(env), Order: toOrder(ord)}, nil
}

func (s *Server) GetSubstitution(context.Context, *v1.GetSubstitutionRequest) (*v1.GetSubstitutionResponse, error) {
	return nil, status.Error(codes.Unimplemented, "substitutions are not supported")
}

func (s *Server) RespondToSubstitution(context.Context, *v1.RespondToSubstitutionRequest) (*v1.RespondToSubstitutionResponse, error) {
	return nil, status.Error(codes.Unimplemented, "substitutions are not supported")
}

func (s *Server) ResetFixtures(ctx context.Context, in *v1.ResetFixturesRequest) (*v1.ResetFixturesResponse, error) {
	res, err := s.K.ResetFixtures(ctx)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.ResetFixturesResponse{FixtureSnapshotId: res.SnapshotID, ContentDigest: res.Digest}, nil
}

func (s *Server) CurrentFixture(ctx context.Context, _ *v1.CurrentFixtureRequest) (*v1.CurrentFixtureResponse, error) {
	res, err := s.K.CurrentFixture(ctx)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CurrentFixtureResponse{FixtureSnapshotId: res.SnapshotID, ContentDigest: res.Digest}, nil
}

func (s *Server) IngestProviderWebhook(ctx context.Context, in *v1.IngestProviderWebhookRequest) (*v1.IngestProviderWebhookResponse, error) {
	if s.Pay == nil {
		return &v1.IngestProviderWebhookResponse{Accepted: false, Code: "PAYMENT_FABRIC_REQUIRED"}, nil
	}
	sig := ""
	if in.Headers != nil {
		sig = in.Headers["x-razorpay-signature"]
		if sig == "" {
			sig = in.Headers["X-Razorpay-Signature"]
		}
	}
	err := s.Pay.IngestWebhook(ctx, payment.WebhookIngest{RawBody: in.RawBody, Signature: sig, EventID: in.EventId})
	if err != nil {
		if payment.Is(err, "PROVIDER_EVENT_DUPLICATE") {
			return &v1.IngestProviderWebhookResponse{Accepted: true, Code: "PROVIDER_EVENT_DUPLICATE"}, nil
		}
		return &v1.IngestProviderWebhookResponse{Accepted: false, Code: err.Error()}, nil
	}
	return &v1.IngestProviderWebhookResponse{Accepted: true, Code: ""}, nil
}

func (s *Server) ClaimRunnerJob(ctx context.Context, in *v1.ClaimRunnerJobRequest) (*v1.ClaimRunnerJobResponse, error) {
	if s.Pay == nil {
		return &v1.ClaimRunnerJobResponse{}, nil
	}
	cred := strings.TrimSpace(bearerFromMD(ctx))
	if cred == "" {
		cred = in.GetExecutorCredential()
	}
	job, err := s.Pay.ClaimRunnerJob(ctx, cred)
	if err != nil {
		if payment.Is(err, "RUNNER_JOB_NOT_FOUND") {
			return &v1.ClaimRunnerJobResponse{}, nil
		}
		return nil, toStatus(err)
	}
	payload, _ := json.Marshal(map[string]any{
		"job_id":             job.JobID,
		"payment_attempt_id": job.PaymentAttemptID,
		"executor_token":     job.ExecutorToken,
		"razorpay_order_id":  job.RazorpayOrderID,
		"razorpay_key_id":    job.RazorpayKeyID,
		"amount_minor":       payment.AmountString(job.AmountMinor),
		"currency":           job.Currency,
		"scenario":           job.Scenario,
		"checkout_page_url":  job.CheckoutPageURL,
		"callback_origin":    job.CallbackOrigin,
		"not_capture":        true,
	})
	return &v1.ClaimRunnerJobResponse{
		JobId: job.JobID, PaymentAttemptId: job.PaymentAttemptID, RazorpayOrderId: job.RazorpayOrderID,
		CheckoutPayloadJson: string(payload),
	}, nil
}

func (s *Server) ReportRunnerObservation(ctx context.Context, in *v1.ReportRunnerObservationRequest) (*v1.ReportRunnerObservationResponse, error) {
	if s.Pay == nil {
		return &v1.ReportRunnerObservationResponse{Accepted: false}, nil
	}
	if !json.Valid([]byte(in.ObservationJson)) {
		return &v1.ReportRunnerObservationResponse{Accepted: false}, nil
	}
	var obs struct {
		ExecutorToken     string `json:"executor_token"`
		ObservedScreen    string `json:"observed_screen"`
		RazorpayOrderID   string `json:"razorpay_order_id"`
		RazorpayPaymentID string `json:"razorpay_payment_id"`
	}
	if err := json.Unmarshal([]byte(in.ObservationJson), &obs); err != nil {
		return &v1.ReportRunnerObservationResponse{Accepted: false}, nil
	}
	err := s.Pay.RecordRunnerObservation(ctx, payment.RunnerObservation{
		JobID: in.JobId, ExecutorToken: obs.ExecutorToken, ExecutorCredential: in.ExecutorCredential,
		ObservedScreen: obs.ObservedScreen, RazorpayOrderID: obs.RazorpayOrderID, RazorpayPaymentID: obs.RazorpayPaymentID,
		ObservationConfidence: "browser_non_authoritative",
	})
	if err != nil {
		return &v1.ReportRunnerObservationResponse{Accepted: false}, nil
	}
	return &v1.ReportRunnerObservationResponse{Accepted: true}, nil
}

func (s *Server) GetMerchantProfile(ctx context.Context, in *v1.GetProfileRequest) (*v1.GetProfileResponse, error) {
	env, p, locs, err := s.K.GetProfile(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.GetProfileResponse{Envelope: toEnv(env), Profile: &v1.MerchantProfile{
		DisplayName: str(p["display_name"]), LegalName: str(p["legal_name"]), Description: str(p["description"]),
		Currency: str(p["currency"]), Locale: str(p["locale"]), Country: str(p["country"]), City: str(p["city"]),
		TimezoneDisplay: str(p["timezone_display"]), SupportEmail: str(p["support_email"]), CapabilitySummary: str(p["capability_summary"]),
	}}
	for _, l := range locs {
		resp.Locations = append(resp.Locations, &v1.Location{
			LocationId: str(l["location_id"]), Name: str(l["name"]), Neighbourhood: str(l["neighbourhood"]), City: str(l["city"]),
			DeliveryFeeMinor: asI64(l["delivery_fee_minor"]), MinimumOrderValueMinor: asI64(l["minimum_order_value_minor"]),
			FreeDeliveryThresholdMinor: asI64(l["free_delivery_threshold_minor"]), EtaMinMinutes: int32(asI64(l["eta_min_minutes"])),
			EtaMaxMinutes: int32(asI64(l["eta_max_minutes"])), Active: asBool(l["active"]), ServiceabilityReference: str(l["serviceability_reference"]), Currency: str(p["currency"]),
		})
	}
	return resp, nil
}

func (s *Server) ListLocations(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListLocationsResponse, error) {
	p, err := s.GetMerchantProfile(ctx, in)
	if err != nil {
		return nil, err
	}
	return &v1.ListLocationsResponse{Envelope: p.Envelope, Locations: p.Locations}, nil
}

func (s *Server) GetAttention(ctx context.Context, in *v1.GetProfileRequest) (*v1.GetAttentionResponse, error) {
	env, a, err := s.K.Attention(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.GetAttentionResponse{Envelope: toEnv(env), Summary: &v1.AttentionSummary{
		Completeness: a.Completeness, Headline: a.Headline,
		UnresolvedMoney: int32(a.Counts["UNRESOLVED_MONEY"]), EvidenceRejected: int32(a.Counts["EVIDENCE_REJECTED"]),
		AuthorizationSecurity: int32(a.Counts["AUTHORIZATION_SECURITY"]), CommerceReplan: int32(a.Counts["STALE_STRATEGY"]),
		RecoveryDelayed: int32(a.Counts["DELAYED_RECOVERY"]), CapturedUnbound: int32(a.Counts["CAPTURED_UNBOUND"]),
		FailedJob: int32(a.Counts["FAILED_JOB"]), InventoryHoldLeak: int32(a.Counts["INVENTORY_HOLD_LEAK"]),
		StaleStrategy: int32(a.Counts["STALE_STRATEGY"]), IncompleteMerchantData: int32(a.Counts["INCOMPLETE_MERCHANT_DATA"]),
		MissingEvaluationEvidence: int32(a.Counts["MISSING_EVALUATION_EVIDENCE"]),
	}}
	for _, item := range a.Items {
		resp.Items = append(resp.Items, &v1.AttentionItem{
			Category: item.Category, Severity: item.Severity, State: item.State, Owner: item.Owner,
			ResourceIds: item.ResourceIDs, Explanation: item.Explanation, NextSafeAction: item.NextSafeAction, RetryAllowed: item.RetryAllowed,
		})
	}
	return resp, nil
}

func (s *Server) SearchResources(ctx context.Context, in *v1.ResourceSearchRequest) (*v1.ResourceSearchResponse, error) {
	env, hits, err := s.K.SearchResources(ctx, meta(ctx, in.Meta), in.Query)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ResourceSearchResponse{Envelope: toEnv(env)}
	for _, h := range hits {
		resp.Hits = append(resp.Hits, &v1.ResourceSearchHit{ResourceType: h["resource_type"], ResourceId: h["resource_id"]})
	}
	return resp, nil
}

func (s *Server) CreateRefund(ctx context.Context, in *v1.CreateRefundRequest) (*v1.CreateRefundResponse, error) {
	env, code, msg, err := s.K.CreateRefund(ctx, meta(ctx, in.Meta), in.MerchantOrderId, in.AmountMinor, in.Currency, in.Reason)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CreateRefundResponse{Envelope: toEnv(env), Code: code, Message: msg}, nil
}

func (s *Server) AdjustInventory(ctx context.Context, in *v1.AdjustInventoryRequest) (*v1.ListInventoryResponse, error) {
	if err := s.K.AdjustInventory(ctx, meta(ctx, in.Meta), in.LocationId, in.SkuId, in.OnHandDelta, in.Reason); err != nil {
		return nil, toStatus(err)
	}
	return s.ListInventory(ctx, &v1.ListInventoryRequest{Meta: in.Meta, LocationId: in.LocationId})
}

func (s *Server) ListInventory(ctx context.Context, in *v1.ListInventoryRequest) (*v1.ListInventoryResponse, error) {
	env, rows, err := s.K.ListInventory(ctx, meta(ctx, in.Meta), in.LocationId)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListInventoryResponse{Envelope: toEnv(env)}
	for _, r := range rows {
		resp.Rows = append(resp.Rows, &v1.InventoryRow{
			LocationId: r.LocationID, SkuId: r.SKUID, OnHandQuantity: r.OnHand, ReservedQuantity: r.Reserved,
			SafetyBuffer: r.SafetyBuffer, SellableQuantity: r.SellableQuantity, StockStatus: r.StockStatus,
		})
	}
	return resp, nil
}

func (s *Server) ListAuditEvents(ctx context.Context, in *v1.ListAuditEventsRequest) (*v1.ListAuditEventsResponse, error) {
	kind := ""
	if len(in.EventKind) > 0 {
		kind = in.EventKind[0]
	}
	env, events, cursor, err := s.K.ListAuditEvents(ctx, meta(ctx, in.Meta), kind, in.ResourceType, in.ResourceId, in.RequestIdFilter, in.OperationId, in.PageSize)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListAuditEventsResponse{Envelope: toEnv(env), NextCursor: cursor}
	for _, e := range events {
		resp.Events = append(resp.Events, toAuditEvent(e))
	}
	return resp, nil
}

func (s *Server) GetAuditEvent(ctx context.Context, in *v1.GetAuditEventRequest) (*v1.GetAuditEventResponse, error) {
	env, e, err := s.K.GetAuditEvent(ctx, meta(ctx, in.Meta), in.AuditEventId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetAuditEventResponse{Envelope: toEnv(env), Event: toAuditEvent(e)}, nil
}

func (s *Server) GetOperationTimeline(ctx context.Context, in *v1.GetOperationTimelineRequest) (*v1.GetOperationTimelineResponse, error) {
	env, events, stages, err := s.K.GetOperationTimeline(ctx, meta(ctx, in.Meta), in.OperationId)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.GetOperationTimelineResponse{Envelope: toEnv(env)}
	for _, e := range events {
		resp.Events = append(resp.Events, toAuditEvent(e))
	}
	for _, st := range stages {
		resp.Stages = append(resp.Stages, &v1.AssuranceStage{Stage: st.Stage, Reached: st.Reached, Authoritative: st.Authoritative, Note: st.Note})
	}
	return resp, nil
}

func (s *Server) GetResourceTimeline(ctx context.Context, in *v1.GetResourceTimelineRequest) (*v1.GetResourceTimelineResponse, error) {
	env, events, err := s.K.GetResourceTimeline(ctx, meta(ctx, in.Meta), in.ResourceType, in.ResourceId)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.GetResourceTimelineResponse{Envelope: toEnv(env)}
	for _, e := range events {
		resp.Events = append(resp.Events, toAuditEvent(e))
	}
	return resp, nil
}

func (s *Server) CreateAuditExport(ctx context.Context, in *v1.CreateAuditExportRequest) (*v1.CreateAuditExportResponse, error) {
	env, id, st, err := s.K.CreateAuditExport(ctx, meta(ctx, in.Meta), in.Format, in.FilterJson)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CreateAuditExportResponse{Envelope: toEnv(env), ExportId: id, Status: st}, nil
}

func (s *Server) GetAuditExport(ctx context.Context, in *v1.GetAuditExportRequest) (*v1.GetAuditExportResponse, error) {
	env, id, st, path, err := s.K.GetAuditExport(ctx, meta(ctx, in.Meta), in.ExportId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetAuditExportResponse{Envelope: toEnv(env), ExportId: id, Status: st, DownloadPath: path}, nil
}

func (s *Server) GetSystemCapabilities(ctx context.Context, in *v1.GetCapabilitiesRequest) (*v1.GetCapabilitiesResponse, error) {
	return s.GetCapabilities(ctx, in)
}

func (s *Server) GetSystemHealth(ctx context.Context, in *v1.GetProfileRequest) (*v1.SystemHealthResponse, error) {
	env, h, err := s.K.SystemHealth(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.SystemHealthResponse{Envelope: toEnv(env), Status: h.Status, Database: h.Database, Migrations: h.Migrations}
	for _, c := range h.Components {
		resp.Components = append(resp.Components, &v1.HealthComponent{
			Name: c.Name, Status: c.Status, Detail: c.Detail, EvidenceStatus: healthEvidence(c.Status),
		})
	}
	return resp, nil
}

func (s *Server) GetMerchantOutcomes(ctx context.Context, in *v1.GetMerchantOutcomesRequest) (*v1.GetMerchantOutcomesResponse, error) {
	env, metrics, err := s.K.MerchantOutcomes(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.GetMerchantOutcomesResponse{Envelope: toEnv(env)}
	for _, m := range metrics {
		resp.Metrics = append(resp.Metrics, &v1.OutcomeMetric{
			Name: m.Name, Eligible: m.Eligible, EvidenceStatus: m.Evidence, Value: m.Value, ValuePresent: m.ValuePresent,
			Numerator: m.Numerator, Denominator: m.Denominator, RatioPresent: m.RatioPresent,
		})
	}
	return resp, nil
}

func (s *Server) ListProducts(ctx context.Context, in *v1.ListProductsRequest) (*v1.ListProductsResponse, error) {
	env, products, err := s.K.ListProductsAdmin(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListProductsResponse{Envelope: toEnv(env)}
	for _, p := range products {
		resp.Products = append(resp.Products, &v1.Product{ProductId: p.ProductID, Name: p.Name, Brand: p.Brand, Category: p.Category, Subcategory: p.Subcategory, CanonicalDescription: p.Description, Lifecycle: p.Lifecycle})
	}
	return resp, nil
}

func (s *Server) GetProductAdmin(ctx context.Context, in *v1.GetProductRequest) (*v1.GetProductResponse, error) {
	if err := s.K.RequireScope(meta(ctx, in.Meta), "merchant:read"); err != nil {
		return nil, toStatus(err)
	}
	row := s.K.Pool().QueryRow(ctx, `SELECT product_id, name, brand, category, subcategory, canonical_description, lifecycle FROM products WHERE product_id=$1`, in.ProductId)
	p := &v1.Product{}
	if err := row.Scan(&p.ProductId, &p.Name, &p.Brand, &p.Category, &p.Subcategory, &p.CanonicalDescription, &p.Lifecycle); err != nil {
		return nil, status.Error(codes.NotFound, "product not found")
	}
	skuRows, err := s.K.Pool().Query(ctx, `SELECT s.sku_id, s.product_id, s.name, s.brand, COALESCE(s.variant,''), s.lifecycle,
		COALESCE((SELECT selling_price_minor FROM prices WHERE sku_id=s.sku_id LIMIT 1),0)
		FROM skus s WHERE s.product_id=$1 ORDER BY s.sku_id`, in.ProductId)
	if err != nil {
		return nil, toStatus(err)
	}
	defer skuRows.Close()
	cur := s.displayCurrency(ctx)
	for skuRows.Next() {
		sku := &v1.Sku{}
		var price int64
		if err := skuRows.Scan(&sku.SkuId, &sku.ProductId, &sku.Name, &sku.Brand, &sku.Variant, &sku.Lifecycle, &price); err != nil {
			return nil, err
		}
		sku.SellingPrice = money(price, cur)
		p.Skus = append(p.Skus, sku)
	}
	if err := skuRows.Err(); err != nil {
		return nil, err
	}
	return &v1.GetProductResponse{Envelope: toEnv(s.KEnv(in.Meta)), Product: p}, nil
}

func (s *Server) ListRelationships(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListRelationshipsResponse, error) {
	env, rels, err := s.K.ListRelationshipsAdmin(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListRelationshipsResponse{Envelope: toEnv(env)}
	for _, r := range rels {
		resp.Relationships = append(resp.Relationships, &v1.Relationship{Source: r.Source, Target: r.Target, Type: r.Type})
	}
	return resp, nil
}

func (s *Server) ListPromotions(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListPromotionsResponse, error) {
	env, promos, err := s.K.ListPromotions(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListPromotionsResponse{Envelope: toEnv(env)}
	for _, p := range promos {
		resp.Promotions = append(resp.Promotions, toPromotion(p))
	}
	return resp, nil
}

func (s *Server) ListStrategies(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListStrategiesResponse, error) {
	if err := s.K.RequireScope(meta(ctx, in.Meta), "merchant:read"); err != nil {
		return nil, toStatus(err)
	}
	rows, err := s.K.ListStrategyConfigs(ctx)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListStrategiesResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for _, r := range rows {
		resp.Strategies = append(resp.Strategies, &v1.StrategyConfig{StrategyType: r.Type, Enabled: r.Enabled, Revision: r.Revision, Surfaces: r.Surfaces, Visibility: r.Visibility})
	}
	return resp, nil
}

func (s *Server) UpdateStrategies(ctx context.Context, in *v1.UpdateStrategiesRequest) (*v1.ListStrategiesResponse, error) {
	var rows []app.StrategyRow
	for _, st := range in.Strategies {
		rows = append(rows, app.StrategyRow{Type: st.StrategyType, Enabled: st.Enabled, Revision: st.Revision, ExpectedRevision: st.ExpectedRevision, Surfaces: st.Surfaces, Visibility: st.Visibility})
	}
	got, err := s.K.UpdateStrategyConfigs(ctx, meta(ctx, in.Meta), rows)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListStrategiesResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for _, r := range got {
		resp.Strategies = append(resp.Strategies, &v1.StrategyConfig{StrategyType: r.Type, Enabled: r.Enabled, Revision: r.Revision, Surfaces: r.Surfaces, Visibility: r.Visibility})
	}
	return resp, nil
}

func (s *Server) PreviewRules(ctx context.Context, in *v1.PreviewRulesRequest) (*v1.PreviewRulesResponse, error) {
	tot, offers, err := s.K.PreviewRuleEconomics(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.PreviewRulesResponse{
		Envelope: toEnv(s.KEnv(in.Meta)),
		Breakdown: &v1.PriceBreakdown{
			Merchandise: money(tot.MerchandiseMinor, tot.Currency),
			Discounts:   money(tot.DiscountsMinor, tot.Currency),
			DeliveryFee: money(tot.DeliveryFeeMinor, tot.Currency),
			HandlingFee: money(tot.HandlingFeeMinor, tot.Currency),
			Tax:         money(tot.TaxMinor, tot.Currency),
			AllInTotal:  money(tot.AllInMinor, tot.Currency),
		},
		Offers: toOffers(offers, tot.Currency),
	}, nil
}

func (s *Server) UpdatePromotion(ctx context.Context, in *v1.UpdatePromotionRequest) (*v1.ListPromotionsResponse, error) {
	if _, err := s.K.UpdatePromotionEnabled(ctx, meta(ctx, in.Meta), in.PromotionId, in.Enabled, in.ExpectedVersion); err != nil {
		return nil, toStatus(err)
	}
	return s.ListPromotions(ctx, &v1.GetProfileRequest{Meta: in.Meta})
}

func (s *Server) ListSessions(ctx context.Context, in *v1.ListSessionsRequest) (*v1.ListSessionsResponse, error) {
	env, sessions, err := s.K.ListSessionsAdmin(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListSessionsResponse{Envelope: toEnv(env)}
	for _, ss := range sessions {
		resp.Sessions = append(resp.Sessions, toSession(ss))
	}
	return resp, nil
}

func (s *Server) GetSessionAdmin(ctx context.Context, in *v1.GetSessionRequest) (*v1.GetSessionResponse, error) {
	list, err := s.ListSessions(ctx, &v1.ListSessionsRequest{Meta: in.Meta, PageSize: 100})
	if err != nil {
		return nil, err
	}
	for _, ss := range list.Sessions {
		if ss.SessionId == in.SessionId {
			return &v1.GetSessionResponse{Envelope: list.Envelope, SessionSummary: ss}, nil
		}
	}
	return nil, status.Error(codes.NotFound, "session not found")
}

func (s *Server) ListOffers(ctx context.Context, in *v1.ListOffersRequest) (*v1.ListOffersResponse, error) {
	if err := s.K.RequireScope(meta(ctx, in.Meta), "merchant:read"); err != nil {
		return nil, toStatus(err)
	}
	rows, err := s.K.Pool().Query(ctx, `SELECT offer_id, strategy_type, session_context_version, cart_version, expires_at, status, grounded_reason, terms, created_at, buyer_impact_minor FROM offers WHERE ($1='' OR session_id=$1) ORDER BY created_at DESC LIMIT 200`, in.SessionId)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	cur := s.displayCurrency(ctx)
	resp := &v1.ListOffersResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		o := &v1.Offer{}
		var created, exp time.Time
		var impact int64
		if err := rows.Scan(&o.OfferId, &o.StrategyType, &o.SessionContextVersion, &o.CartVersion, &exp, &o.Status, &o.GroundedReason, &o.Terms, &created, &impact); err != nil {
			return nil, err
		}
		o.ExpiresAt = timestamppb.New(exp)
		o.BuyerImpact = money(impact, cur)
		resp.Offers = append(resp.Offers, o)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return resp, nil
}

func (s *Server) GetOffer(ctx context.Context, in *v1.GetOfferRequest) (*v1.GetOfferResponse, error) {
	if err := s.K.RequireScope(meta(ctx, in.Meta), "merchant:read"); err != nil {
		return nil, toStatus(err)
	}
	var view app.OfferView
	err := s.K.Pool().QueryRow(ctx, `SELECT offer_id, strategy_type, session_context_version, cart_version, expires_at, status, grounded_reason, terms, cart_patch, buyer_impact_minor, discount_amount_minor, quote_delta_minor, public_explanation FROM offers WHERE offer_id=$1`, in.OfferId).
		Scan(&view.OfferID, &view.StrategyType, &view.SessionContextVersion, &view.CartVersion, &view.ExpiresAt, &view.Status, &view.GroundedReason, &view.Terms, &view.PatchJSON, &view.BuyerImpactMinor, &view.DiscountAmountMinor, &view.QuoteDeltaMinor, &view.ExplanationJSON)
	if err != nil {
		return nil, status.Error(codes.NotFound, "offer not found")
	}
	cur := s.displayCurrency(ctx)
	o := toOffer(view, cur)
	return &v1.GetOfferResponse{Envelope: toEnv(s.KEnv(in.Meta)), Offer: o, CandidateJson: string(view.PatchJSON)}, nil
}

func (s *Server) ListOrders(ctx context.Context, in *v1.ListOrdersRequest) (*v1.ListOrdersResponse, error) {
	if err := s.K.RequireScope(meta(ctx, in.Meta), "merchant:read"); err != nil {
		return nil, toStatus(err)
	}
	rows, err := s.K.Pool().Query(ctx, `SELECT order_id, session_id, COALESCE(checkout_proposal_id,''), status, total_amount_minor, currency, COALESCE(payment_attempt_id,''), COALESCE(payment_public_status,''), location_id, created_at FROM orders ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListOrdersResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		o := &v1.MerchantOrder{}
		var total int64
		var currency string
		var created time.Time
		if err := rows.Scan(&o.MerchantOrderId, &o.SessionId, &o.CheckoutProposalId, &o.Status, &total, &currency, &o.PaymentAttemptId, &o.PaymentPublicStatus, &o.LocationId, &created); err != nil {
			return nil, err
		}
		o.Total = money(total, currency)
		o.CreatedAt = timestamppb.New(created)
		resp.Orders = append(resp.Orders, o)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return resp, nil
}

func (s *Server) GetOrderAdmin(ctx context.Context, in *v1.GetOrderAdminRequest) (*v1.GetOrderResponse, error) {
	list, err := s.ListOrders(ctx, &v1.ListOrdersRequest{Meta: in.Meta})
	if err != nil {
		return nil, err
	}
	for _, o := range list.Orders {
		if o.MerchantOrderId == in.MerchantOrderId {
			env, card, aerr := s.K.PaymentAssuranceForOrder(ctx, meta(ctx, in.Meta), in.MerchantOrderId, o.PaymentAttemptId)
			respEnv := list.Envelope
			if aerr == nil {
				respEnv = toEnv(env)
				if respEnv.Correlation == nil {
					respEnv.Correlation = map[string]string{}
				}
				respEnv.Correlation["payment_attempt_id"] = card.PaymentAttemptID
				respEnv.Correlation["provider_order_id"] = card.ProviderOrderID
				respEnv.Correlation["provider_payment_id"] = card.ProviderPaymentID
				respEnv.Correlation["webhook_bound"] = boolText(card.WebhookBound)
				respEnv.Correlation["callback_bound"] = boolText(card.CallbackBound)
				respEnv.Correlation["event_binding_status"] = map[bool]string{true: "BOUND", false: "UNBOUND"}[card.WebhookBound || card.CallbackBound]
				respEnv.Correlation["authenticated_provider_event_ref"] = card.AuthenticatedEventRef
				respEnv.Correlation["provider_fetch_ref"] = card.ProviderFetchRef
				respEnv.Correlation["fetch_at"] = card.FetchAt
				respEnv.Correlation["amount_match"] = card.AmountMatch
				respEnv.Correlation["final_state"] = card.FinalState
				respEnv.Correlation["capture_state"] = card.FinalState
				respEnv.Correlation["reconciliation_state"] = card.EvidenceStatus
				respEnv.Correlation["hold_disposition"] = card.HoldDisposition
				respEnv.Correlation["evidence_status"] = card.EvidenceStatus
				respEnv.Correlation["assurance_message"] = card.Message
				respEnv.Correlation["runner_screen_is_not_truth"] = "true"
				respEnv.Correlation["merchant_order_id"] = card.MerchantOrderID
				respEnv.Correlation["order_confirmed"] = boolText(card.OrderConfirmed)
				respEnv.Correlation["retry_allowed"] = boolText(card.FinalState != "OUTCOME_UNKNOWN")
				respEnv.Correlation["settlement_status"] = "NOT_IMPLEMENTED"
				respEnv.Correlation["assurance_projection_version"] = "payment_assurance_v1"
			}
			return &v1.GetOrderResponse{Envelope: respEnv, Order: o}, nil
		}
	}
	return nil, status.Error(codes.NotFound, "order not found")
}

func (s *Server) ListHosts(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListHostsResponse, error) {
	env, hosts, err := s.K.ListHostsAdmin(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListHostsResponse{Envelope: toEnv(env)}
	for _, h := range hosts {
		resp.Hosts = append(resp.Hosts, &v1.HostRecord{HostId: h.HostID, DisplayName: h.DisplayName, Status: h.Status, Scopes: h.Scopes})
	}
	return resp, nil
}

func (s *Server) ListOperations(ctx context.Context, in *v1.ListOperationsRequest) (*v1.ListOperationsResponse, error) {
	env, jobs, err := s.K.ListJobs(ctx, meta(ctx, in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListOperationsResponse{Envelope: toEnv(env)}
	for _, j := range jobs {
		resp.Jobs = append(resp.Jobs, &v1.JobRow{
			JobId: j.JobID, JobType: j.JobType, Status: j.Status, OperationId: j.OperationID,
			AttemptCount: j.AttemptCount, LastErrorClass: j.LastErrorClass, NextRetryAt: j.NextRetryAt,
			LeaseOwner: j.LeaseOwner, LeaseExpiresAt: j.LeaseExpiresAt, Retryable: j.Retryable,
			DeadLetterReason: j.DeadLetterReason, OperatorAction: j.OperatorAction, LastError: j.LastError,
		})
	}
	return resp, nil
}

func (s *Server) ReconcileOperation(ctx context.Context, in *v1.ReconcileOperationRequest) (*v1.ReconcileOperationResponse, error) {
	env, r, err := s.K.ReconcileOperation(ctx, meta(ctx, in.Meta), in.OperationId)
	if err != nil {
		return nil, toStatus(err)
	}
	if s.Pay != nil && in.GetOperationId() != "" {
		_ = s.Pay.OperatorReconcile(ctx, in.GetOperationId())
	}
	return &v1.ReconcileOperationResponse{Envelope: toEnv(env), Scheduled: r.Scheduled, Status: r.Status, JobId: r.JobID, Code: r.Code}, nil
}

func (s *Server) UpdateMerchantProfile(ctx context.Context, in *v1.UpdateProfileRequest) (*v1.GetProfileResponse, error) {
	if err := s.K.UpdateMerchantProfile(ctx, meta(ctx, in.Meta), in.DisplayName, in.Description, in.SupportEmail, in.ExpectedVersion); err != nil {
		return nil, toStatus(err)
	}
	return s.GetMerchantProfile(ctx, &v1.GetProfileRequest{Meta: in.Meta})
}

func (s *Server) KEnv(m *v1.RequestMeta) app.Envelope {
	e := app.Envelope{ContractVersion: app.ContractVersion, OccurredAt: time.Now().UTC()}
	if m != nil {
		e.RequestID = m.RequestId
	}
	return e
}

func toPromotion(p app.PromotionView) *v1.Promotion {
	return &v1.Promotion{
		PromotionId: p.ID, Type: p.Type, Name: p.Name, EligibleSkuIds: p.EligibleSKUs, MinimumQuantity: p.MinQty,
		DiscountAmountMinor: p.DiscountMinor, Enabled: p.Enabled, Revision: p.Revision, EligibleLocationIds: p.EligibleLocations,
		MinimumBasketValueMinor: p.MinBasketMinor, BenefitType: p.BenefitType, FundingSplit: p.FundingSplit,
		BudgetCapMinor: p.BudgetCapMinor, CurrentUsageMinor: p.CurrentUsageMinor, StartsAt: p.StartsAt, EndsAt: p.EndsAt,
		AttributionStatus: p.AttributionStatus,
	}
}

func toMut(out app.CartMutation) *v1.CartMutationResult {
	return &v1.CartMutationResult{Envelope: toEnv(out.Envelope), SessionSummary: toSession(out.Session), Cart: toCart(out.Cart), Offers: toOffers(out.Offers, out.Session.Currency), InvalidatedOfferIds: out.InvalidatedOfferIDs, TreatmentPolicy: toPolicy(out.Session.Treatment)}
}

func toEnv(e app.Envelope) *v1.Envelope {
	return &v1.Envelope{ContractVersion: e.ContractVersion, RequestId: e.RequestID, OccurredAt: timestamppb.New(e.OccurredAt), OperationId: e.OperationID, Correlation: e.Correlation}
}

func toAuditEvent(e app.AuditEventView) *v1.AuditEvent {
	return &v1.AuditEvent{
		AuditEventId: e.ID, RecordSequence: e.Sequence, EventKind: e.Kind, OccurredAt: e.OccurredAt, RequestId: e.RequestID,
		OperationId: e.OperationID, Action: e.Action, PrimaryResourceType: e.ResourceType, PrimaryResourceId: e.ResourceID,
		SummarySentence: e.Summary, AttentionCode: e.Attention, EventBodyJson: string(e.BodyJSON),
		Correlation: e.Correlation, NonAuthoritative: e.NonAuthoritative,
	}
}

func toSession(s app.SessionSummary) *v1.SessionSummary {
	ss := &v1.SessionSummary{SessionId: s.SessionID, SessionContextVersion: s.SessionContextVersion, LocationId: s.LocationID, Status: s.Status, CartId: s.CartID, CartVersion: s.CartVersion, Mission: s.Mission, Currency: s.Currency}
	if s.HasBudget {
		ss.PlanningBudget = &v1.Money{AmountMinor: s.PlanningBudgetMinor, Currency: s.Currency}
	}
	return ss
}

func toPolicy(p *commerce.TreatmentPolicy) *v1.TreatmentPolicy {
	if p == nil {
		return nil
	}
	return &v1.TreatmentPolicy{
		PolicyId: p.PolicyID, StrategyAllowlist: p.StrategyAllowlist, StrategyRevisions: p.StrategyRevisions,
		CampaignRevisions: p.CampaignRevisions, RankingVersion: p.RankingVersion, EconomicObjectiveVersion: p.EconomicObjectiveVersion,
		PolicyDigest: p.PolicyDigest, Arm: p.Arm, EffectiveAt: timestamppb.New(p.EffectiveAt),
	}
}

func toCart(c app.CartView) *v1.Cart {
	out := &v1.Cart{CartId: c.CartID, SessionId: c.SessionID, CartVersion: c.Version, Currency: c.Currency, Breakdown: &v1.PriceBreakdown{
		Merchandise: money(c.Totals.MerchandiseMinor, c.Currency), Discounts: money(c.Totals.DiscountsMinor, c.Currency),
		DeliveryFee: money(c.Totals.DeliveryFeeMinor, c.Currency), HandlingFee: money(c.Totals.HandlingFeeMinor, c.Currency),
		Tax: money(c.Totals.TaxMinor, c.Currency), AllInTotal: money(c.Totals.AllInMinor, c.Currency),
	}}
	for _, l := range c.Lines {
		out.Lines = append(out.Lines, &v1.CartLine{CartLineId: l.LineID, SkuId: l.SKUID, ProductId: l.ProductID, Name: l.Name, Quantity: l.Quantity, UnitPrice: money(l.UnitMinor, c.Currency), LineTotal: money(l.LineMinor, c.Currency)})
	}
	return out
}

func toOffers(os []app.OfferView, currency string) []*v1.Offer {
	var out []*v1.Offer
	for _, o := range os {
		out = append(out, toOffer(o, currency))
	}
	return out
}

func toOffer(o app.OfferView, currency string) *v1.Offer {
	var patch appPatch
	_ = json.Unmarshal(o.PatchJSON, &patch)
	p := &v1.CartPatch{PatchType: patch.Type, SourceCartLineId: patch.SourceLineID, SourceSkuId: patch.SourceSKUID, PromotionId: patch.PromotionID, BundleId: patch.BundleID}
	for _, l := range patch.Lines {
		p.Lines = append(p.Lines, &v1.CartPatchLine{SkuId: l.SKUID, Quantity: int32(l.Quantity), Op: l.Op})
	}
	out := &v1.Offer{OfferId: o.OfferID, StrategyType: o.StrategyType, SessionContextVersion: o.SessionContextVersion, CartVersion: o.CartVersion, ExpiresAt: timestamppb.New(o.ExpiresAt), Status: o.Status, GroundedReason: o.GroundedReason, Terms: o.Terms, CartPatch: p, BuyerImpact: money(o.BuyerImpactMinor, currency), BaseAllInTotal: money(o.BaseAllInMinor, currency), ProjectedAllInTotal: money(o.PatchedAllInMinor, currency)}
	attachPublicEconomics(out, o, patch)
	return out
}

func attachPublicEconomics(out *v1.Offer, o app.OfferView, patch appPatch) {
	econ := &v1.OfferEconomics{
		DiscountAmountMinor: o.DiscountAmountMinor,
		QuoteDeltaMinor:     o.QuoteDeltaMinor,
	}
	if patch.Economics != nil {
		econ.ItemCostMinor = patch.Economics.ItemCostMinor
		econ.ThresholdGapMinor = patch.Economics.ThresholdGapMinor
		econ.FeeSavingMinor = patch.Economics.FeeSavingMinor
	}
	var expl commerce.PublicExplanation
	if len(o.ExplanationJSON) > 0 {
		_ = json.Unmarshal(o.ExplanationJSON, &expl)
	}
	if expl.WhatChanged != "" || expl.WhyEligible != "" || expl.FundedBy != "" || expl.DeliveryChange != "" {
		econ.Explanation = &v1.OfferExplanation{
			WhatChanged:         expl.WhatChanged,
			WhyEligible:         expl.WhyEligible,
			BuyerCostDeltaMinor: expl.BuyerCostDeltaMinor,
			BuyerSaveMinor:      expl.BuyerSaveMinor,
			DeliveryChange:      expl.DeliveryChange,
			QuantityChange:      expl.QuantityChange,
			FundedBy:            expl.FundedBy,
		}
	}
	if econ.ItemCostMinor == 0 && econ.ThresholdGapMinor == 0 && econ.FeeSavingMinor == 0 && econ.DiscountAmountMinor == 0 && econ.QuoteDeltaMinor == 0 && econ.Explanation == nil {
		return
	}
	out.Economics = econ
}

type appPatch struct {
	Type  string `json:"Type"`
	Lines []struct {
		SKUID    string `json:"SKUID"`
		Quantity int    `json:"Quantity"`
		Op       string `json:"Op"`
	}
	SourceLineID string `json:"SourceLineID"`
	SourceSKUID  string `json:"SourceSKUID"`
	PromotionID  string `json:"PromotionID"`
	BundleID     string `json:"BundleID"`
	Economics    *struct {
		ItemCostMinor     int64 `json:"item_cost_minor"`
		ThresholdGapMinor int64 `json:"threshold_gap_minor"`
		FeeSavingMinor    int64 `json:"fee_saving_minor"`
	} `json:"economics"`
}

func toSKU(s app.SKUView, currency string) *v1.Sku {
	return &v1.Sku{SkuId: s.SKUID, ProductId: s.ProductID, Name: s.Name, Brand: s.Brand, Variant: s.Variant, PackSize: s.PackSize, UnitOfMeasure: s.UOM, Barcode: s.Barcode, CanonicalDescription: s.Description, Lifecycle: s.Lifecycle, SellingPrice: money(s.SellingMinor, currency), SellableQuantity: s.Sellable, StockStatus: s.StockStatus, Assorted: s.Assorted}
}

func toProposal(p app.ProposalView) *v1.CheckoutProposal {
	out := &v1.CheckoutProposal{CheckoutProposalId: p.ProposalID, SessionId: p.SessionID, SessionContextVersion: p.SessionContextVersion, CartId: p.CartID, CartVersion: p.CartVersion, QuoteHash: p.QuoteHash, FinalAmount: money(p.FinalMinor, p.Currency), PaymentCapabilityId: p.Capability, Status: p.Status, LocationId: p.LocationID, Breakdown: &v1.PriceBreakdown{AllInTotal: money(p.FinalMinor, p.Currency)}}
	t, _ := time.Parse(time.RFC3339, p.HoldExpiresAt+"Z")
	if t.IsZero() {
		t, _ = time.Parse("2006-01-02T15:04:05Z", p.HoldExpiresAt)
	}
	out.HoldExpiresAt = timestamppb.New(t)
	out.ProposalExpiresAt = timestamppb.New(t)
	for _, l := range p.Lines {
		out.Lines = append(out.Lines, &v1.CartLine{CartLineId: l.LineID, SkuId: l.SKUID, ProductId: l.ProductID, Name: l.Name, Quantity: l.Quantity, UnitPrice: money(l.UnitMinor, p.Currency), LineTotal: money(l.LineMinor, p.Currency)})
	}
	return out
}

func toOrder(o app.OrderView) *v1.MerchantOrder {
	mo := &v1.MerchantOrder{MerchantOrderId: o.OrderID, SessionId: o.SessionID, CheckoutProposalId: o.ProposalID, Status: o.Status, Total: money(o.TotalMinor, o.Currency), PaymentAttemptId: o.PaymentAttemptID, PaymentPublicStatus: o.PaymentPublicStatus, LocationId: o.LocationID, OperationId: o.OperationID}
	for _, l := range o.Lines {
		mo.Lines = append(mo.Lines, &v1.CartLine{SkuId: l.SKUID, ProductId: l.ProductID, Quantity: l.Quantity, UnitPrice: money(l.UnitMinor, o.Currency), LineTotal: money(l.LineMinor, o.Currency)})
	}
	return mo
}

func money(minor int64, cur string) *v1.Money {
	return &v1.Money{AmountMinor: minor, Currency: cur}
}

func toStatus(err error) error {
	e := apperr.As(err)
	if e == nil {
		return status.Error(codes.Internal, apperr.TemporarilyUnavailable)
	}
	code := codes.FailedPrecondition
	switch e.Code {
	case apperr.HostUnauthenticated, apperr.Unauthenticated:
		code = codes.Unauthenticated
	case apperr.HostForbidden, apperr.Forbidden:
		code = codes.PermissionDenied
	case apperr.NotFound:
		code = codes.NotFound
	case apperr.InvalidArgument:
		code = codes.InvalidArgument
	case apperr.VersionConflict:
		code = codes.Aborted
	case apperr.NotReconcilable:
		code = codes.FailedPrecondition
	case apperr.RateLimited:
		code = codes.ResourceExhausted
	}
	st := status.New(code, e.Code)
	d := &v1.ErrorDetail{Code: e.Code, Message: publicMessage(e), Retryable: e.Retryable, RetryAfterMs: e.RetryAfter, OperationId: e.Operation, Details: e.Details}
	if s, ok := e.Session.(app.SessionSummary); ok {
		d.CurrentSessionSummary = toSession(s)
	}
	if c, ok := e.Cart.(app.CartView); ok {
		d.CurrentCart = toCart(c)
	}
	st, _ = st.WithDetails(d)
	return st.Err()
}

func publicMessage(e *apperr.E) string {
	if e == nil {
		return apperr.TemporarilyUnavailable
	}
	msg := e.Message
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "sql") || strings.Contains(lower, "postgres") || strings.Contains(lower, "/") && strings.Contains(lower, ".go") {
		return e.Code
	}
	return msg
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func (s *Server) displayCurrency(ctx context.Context) string {
	if s.K == nil {
		return ""
	}
	var c string
	_ = s.K.Pool().QueryRow(ctx, `SELECT currency FROM merchant_profile WHERE singleton_key='singleton'`).Scan(&c)
	return c
}

func asI64(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case int32:
		return int64(t)
	case float64:
		return int64(t)
	default:
		return 0
	}
}

func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func boolText(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func healthEvidence(status string) string {
	switch status {
	case "READY", "CONFIGURED":
		return "CONFIRMED"
	case "DEGRADED":
		return "PARTIAL"
	case "UNKNOWN":
		return "UNAVAILABLE"
	case "NOT_READY":
		return "UNAVAILABLE"
	default:
		return "MEASURED"
	}
}
