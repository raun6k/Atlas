package grpcapi

import (
	"context"
	"encoding/json"
	"time"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/apperr"
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

func meta(m *v1.RequestMeta) app.Meta {
	if m == nil {
		return app.Meta{}
	}
	return app.Meta{
		RequestID:        m.RequestId,
		IdempotencyKey:   m.IdempotencyKey,
		HostRequestProof: m.HostRequestProof,
		ApprovedHostID:   m.ApprovedHostId,
		OperatorID:       m.OperatorId,
		OperatorScopes:   m.OperatorScopes,
	}
}

func (s *Server) GetCapabilities(ctx context.Context, in *v1.GetCapabilitiesRequest) (*v1.GetCapabilitiesResponse, error) {
	env, cap, err := s.K.GetCapabilities(ctx, meta(in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetCapabilitiesResponse{Envelope: toEnv(env), Capabilities: &v1.Capabilities{
		ContractFamily: cap.ContractFamily, ContractVersion: cap.ContractVersion, MerchantDisplayName: cap.MerchantDisplayName,
		Currency: cap.Currency, Locale: cap.Locale, Tools: cap.Tools, MaxPageSize: cap.MaxPageSize,
		OfferTtlSeconds: cap.OfferTTLSeconds, ProposalHoldTtlSeconds: cap.ProposalHoldTTLSeconds,
		Payment: &v1.PaymentCapability{
			CapabilityId: "pcap_razorpay_test", Provider: "razorpay", Environment: "test", MoneyMovement: "simulated",
			CompletionMode: "asynchronous", RequiresCheckoutProposal: true, RequiresCheckoutAuthority: true,
			SupportsBuyerAgentRawInstrumentAccess: false, TerminalSuccessState: "CAPTURED_RECONCILED",
		},
	}}, nil
}

func (s *Server) GetProfile(ctx context.Context, in *v1.GetProfileRequest) (*v1.GetProfileResponse, error) {
	return s.GetMerchantProfile(ctx, in)
}

func (s *Server) SearchCatalog(ctx context.Context, in *v1.SearchCatalogRequest) (*v1.SearchCatalogResponse, error) {
	m := meta(in.Meta)
	env, items, cursor, offers, err := s.K.SearchCatalog(ctx, m, in.SessionId, in.Query, in.Category, in.Brand, in.Cursor, in.PageSize)
	if err != nil {
		return nil, toStatus(err)
	}
	out := &v1.SearchCatalogResponse{Envelope: toEnv(env), NextCursor: cursor, Offers: toOffers(offers)}
	for _, it := range items {
		out.Items = append(out.Items, toSKU(it))
	}
	return out, nil
}

func (s *Server) GetProduct(ctx context.Context, in *v1.GetProductRequest) (*v1.GetProductResponse, error) {
	env, p, err := s.K.GetProduct(ctx, meta(in.Meta), in.SessionId, in.ProductId, in.LocationId)
	if err != nil {
		return nil, toStatus(err)
	}
	prod := &v1.Product{ProductId: p.ProductID, Name: p.Name, Brand: p.Brand, Category: p.Category, Subcategory: p.Subcategory, CanonicalDescription: p.Description, Dietary: p.Dietary, Lifecycle: p.Lifecycle}
	for _, sku := range p.SKUs {
		prod.Skus = append(prod.Skus, toSKU(sku))
	}
	return &v1.GetProductResponse{Envelope: toEnv(env), Product: prod}, nil
}

func (s *Server) CreateSession(ctx context.Context, in *v1.CreateSessionRequest) (*v1.CreateSessionResponse, error) {
	m := meta(in.Meta)
	m.Arguments = map[string]any{"subject_reference": in.SubjectReference, "delivery_serviceability_reference": in.DeliveryServiceabilityReference, "locale": in.Locale, "requested_location_id": in.RequestedLocationId, "evaluation_arm": in.EvaluationArm}
	out, err := s.K.CreateSession(ctx, m, in.SubjectReference, in.DeliveryServiceabilityReference, in.Locale, in.RequestedLocationId, in.EvaluationArm)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CreateSessionResponse{Envelope: toEnv(out.Envelope), SessionSummary: toSession(out.Session), Cart: toCart(out.Cart), Offers: toOffers(out.Offers)}, nil
}

func (s *Server) SetIntent(ctx context.Context, in *v1.SetIntentRequest) (*v1.SetIntentResponse, error) {
	m := meta(in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "expected_session_context_version": in.ExpectedSessionContextVersion, "mission": in.Mission, "planning_budget_minor": in.PlanningBudgetMinor, "currency": in.Currency}
	out, err := s.K.SetIntent(ctx, m, in.SessionId, in.ExpectedSessionContextVersion, in.Mission, in.PlanningBudgetMinor, in.Currency, in.Constraints)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.SetIntentResponse{Envelope: toEnv(out.Envelope), SessionSummary: toSession(out.Session), Cart: toCart(out.Cart), Offers: toOffers(out.Offers), InvalidatedOfferIds: out.InvalidatedOfferIDs}, nil
}

func (s *Server) GetSession(ctx context.Context, in *v1.GetSessionRequest) (*v1.GetSessionResponse, error) {
	env, sess, cart, err := s.K.GetSession(ctx, meta(in.Meta), in.SessionId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetSessionResponse{Envelope: toEnv(env), SessionSummary: toSession(sess), Cart: toCart(cart), SubjectReference: sess.SubjectReference, HostId: sess.HostID}, nil
}

func (s *Server) GetCart(ctx context.Context, in *v1.GetCartRequest) (*v1.GetCartResponse, error) {
	out, err := s.K.GetCart(ctx, meta(in.Meta), in.SessionId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetCartResponse{Envelope: toEnv(out.Envelope), SessionSummary: toSession(out.Session), Cart: toCart(out.Cart), Offers: toOffers(out.Offers)}, nil
}

func (s *Server) AddItem(ctx context.Context, in *v1.AddItemRequest) (*v1.CartMutationResult, error) {
	m := meta(in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "cart_id": in.CartId, "expected_cart_version": in.ExpectedCartVersion, "sku_id": in.SkuId, "quantity": in.Quantity}
	out, err := s.K.AddItem(ctx, m, in.SessionId, in.CartId, in.ExpectedCartVersion, in.SkuId, in.Quantity)
	if err != nil {
		return nil, toStatus(err)
	}
	return toMut(out), nil
}

func (s *Server) UpdateItem(ctx context.Context, in *v1.UpdateItemRequest) (*v1.CartMutationResult, error) {
	m := meta(in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "cart_id": in.CartId, "expected_cart_version": in.ExpectedCartVersion, "cart_line_id": in.CartLineId, "quantity": in.Quantity}
	out, err := s.K.UpdateItem(ctx, m, in.SessionId, in.CartId, in.ExpectedCartVersion, in.CartLineId, in.Quantity)
	if err != nil {
		return nil, toStatus(err)
	}
	return toMut(out), nil
}

func (s *Server) RemoveItem(ctx context.Context, in *v1.RemoveItemRequest) (*v1.CartMutationResult, error) {
	m := meta(in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "cart_id": in.CartId, "expected_cart_version": in.ExpectedCartVersion, "cart_line_id": in.CartLineId}
	out, err := s.K.RemoveItem(ctx, m, in.SessionId, in.CartId, in.ExpectedCartVersion, in.CartLineId)
	if err != nil {
		return nil, toStatus(err)
	}
	return toMut(out), nil
}

func (s *Server) ApplyOffer(ctx context.Context, in *v1.ApplyOfferRequest) (*v1.CartMutationResult, error) {
	m := meta(in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "offer_id": in.OfferId, "expected_session_context_version": in.ExpectedSessionContextVersion, "expected_cart_version": in.ExpectedCartVersion}
	out, err := s.K.ApplyOffer(ctx, m, in.SessionId, in.OfferId, in.ExpectedSessionContextVersion, in.ExpectedCartVersion)
	if err != nil {
		return nil, toStatus(err)
	}
	return toMut(out), nil
}

func (s *Server) PrepareCheckout(ctx context.Context, in *v1.PrepareCheckoutRequest) (*v1.PrepareCheckoutResponse, error) {
	m := meta(in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "cart_id": in.CartId, "expected_session_context_version": in.ExpectedSessionContextVersion, "expected_cart_version": in.ExpectedCartVersion}
	env, sess, cart, prop, err := s.K.PrepareCheckout(ctx, m, in.SessionId, in.CartId, in.ExpectedSessionContextVersion, in.ExpectedCartVersion)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.PrepareCheckoutResponse{Envelope: toEnv(env), SessionSummary: toSession(sess), Cart: toCart(cart), Proposal: toProposal(prop)}, nil
}

func (s *Server) CompleteCheckout(ctx context.Context, in *v1.CompleteCheckoutRequest) (*v1.CompleteCheckoutResponse, error) {
	m := meta(in.Meta)
	m.Arguments = map[string]any{"session_id": in.SessionId, "checkout_proposal_id": in.CheckoutProposalId}
	env, ord, err := s.K.CompleteCheckout(ctx, m, in.SessionId, in.CheckoutProposalId, in.CheckoutAuthority)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CompleteCheckoutResponse{Envelope: toEnv(env), MerchantOrderId: ord.OrderID, PaymentAttemptId: ord.PaymentAttemptID, OperationId: env.OperationID, PublicStatus: "PAYMENT_PROCESSING", Order: toOrder(ord)}, nil
}

func (s *Server) GetOrder(ctx context.Context, in *v1.GetOrderRequest) (*v1.GetOrderResponse, error) {
	env, ord, err := s.K.GetOrder(ctx, meta(in.Meta), in.SessionId, in.MerchantOrderId)
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
	job, err := s.Pay.ClaimRunnerJob(ctx, in.ExecutorCredential)
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
	var obs struct {
		ExecutorToken     string `json:"executor_token"`
		ObservedScreen    string `json:"observed_screen"`
		RazorpayOrderID   string `json:"razorpay_order_id"`
		RazorpayPaymentID string `json:"razorpay_payment_id"`
	}
	_ = json.Unmarshal([]byte(in.ObservationJson), &obs)
	err := s.Pay.RecordRunnerObservation(ctx, payment.RunnerObservation{
		JobID: in.JobId, ExecutorToken: obs.ExecutorToken, ObservedScreen: obs.ObservedScreen,
		RazorpayOrderID: obs.RazorpayOrderID, RazorpayPaymentID: obs.RazorpayPaymentID,
	})
	if err != nil {
		return &v1.ReportRunnerObservationResponse{Accepted: false}, nil
	}
	return &v1.ReportRunnerObservationResponse{Accepted: true}, nil
}

func (s *Server) GetMerchantProfile(ctx context.Context, in *v1.GetProfileRequest) (*v1.GetProfileResponse, error) {
	env, p, locs, err := s.K.GetProfile(ctx, meta(in.Meta))
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
			EtaMaxMinutes: int32(asI64(l["eta_max_minutes"])), Active: asBool(l["active"]), ServiceabilityReference: str(l["serviceability_reference"]), Currency: "INR",
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
	env, a, err := s.K.Attention(ctx, meta(in.Meta))
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetAttentionResponse{Envelope: toEnv(env), Summary: &v1.AttentionSummary{
		Completeness: str(a["completeness"]), UnresolvedMoney: int32(asI64(a["unresolved_money"])), Headline: str(a["headline"]),
	}}, nil
}

func (s *Server) SearchResources(ctx context.Context, in *v1.ResourceSearchRequest) (*v1.ResourceSearchResponse, error) {
	env, hits, err := s.K.SearchResources(ctx, meta(in.Meta), in.Query)
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
	env, code, msg, err := s.K.CreateRefund(ctx, meta(in.Meta), in.MerchantOrderId, in.AmountMinor, in.Currency, in.Reason)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CreateRefundResponse{Envelope: toEnv(env), Code: code, Message: msg}, nil
}

func (s *Server) AdjustInventory(ctx context.Context, in *v1.AdjustInventoryRequest) (*v1.ListInventoryResponse, error) {
	if err := s.K.AdjustInventory(ctx, meta(in.Meta), in.LocationId, in.SkuId, in.OnHandDelta, in.Reason); err != nil {
		return nil, toStatus(err)
	}
	return s.ListInventory(ctx, &v1.ListInventoryRequest{Meta: in.Meta, LocationId: in.LocationId})
}

func (s *Server) ListInventory(ctx context.Context, in *v1.ListInventoryRequest) (*v1.ListInventoryResponse, error) {
	rows, err := s.K.Pool().Query(ctx, `SELECT location_id, sku_id, on_hand_quantity, reserved_quantity, safety_buffer, GREATEST(on_hand_quantity-reserved_quantity-safety_buffer,0), stock_status FROM inventory WHERE ($1='' OR location_id=$1) ORDER BY sku_id LIMIT 500`, in.LocationId)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListInventoryResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		var r v1.InventoryRow
		if err := rows.Scan(&r.LocationId, &r.SkuId, &r.OnHandQuantity, &r.ReservedQuantity, &r.SafetyBuffer, &r.SellableQuantity, &r.StockStatus); err != nil {
			return nil, err
		}
		resp.Rows = append(resp.Rows, &r)
	}
	return resp, nil
}

func (s *Server) ListAuditEvents(ctx context.Context, in *v1.ListAuditEventsRequest) (*v1.ListAuditEventsResponse, error) {
	kind := ""
	if len(in.EventKind) > 0 {
		kind = in.EventKind[0]
	}
	env, events, cursor, err := s.K.ListAuditEvents(ctx, meta(in.Meta), kind, in.ResourceType, in.ResourceId, in.RequestIdFilter, in.OperationId, in.PageSize)
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
	env, e, err := s.K.GetAuditEvent(ctx, meta(in.Meta), in.AuditEventId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetAuditEventResponse{Envelope: toEnv(env), Event: toAuditEvent(e)}, nil
}

func (s *Server) GetOperationTimeline(ctx context.Context, in *v1.GetOperationTimelineRequest) (*v1.GetOperationTimelineResponse, error) {
	env, events, stages, err := s.K.GetOperationTimeline(ctx, meta(in.Meta), in.OperationId)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.GetOperationTimelineResponse{Envelope: toEnv(env)}
	for _, e := range events {
		resp.Events = append(resp.Events, toAuditEvent(e))
	}
	for _, st := range stages {
		resp.Stages = append(resp.Stages, &v1.AssuranceStage{Stage: st, Reached: true})
	}
	return resp, nil
}

func (s *Server) GetResourceTimeline(ctx context.Context, in *v1.GetResourceTimelineRequest) (*v1.GetResourceTimelineResponse, error) {
	env, events, err := s.K.GetResourceTimeline(ctx, meta(in.Meta), in.ResourceType, in.ResourceId)
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
	env, id, st, err := s.K.CreateAuditExport(ctx, meta(in.Meta), in.Format, in.FilterJson)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.CreateAuditExportResponse{Envelope: toEnv(env), ExportId: id, Status: st}, nil
}

func (s *Server) GetAuditExport(ctx context.Context, in *v1.GetAuditExportRequest) (*v1.GetAuditExportResponse, error) {
	env, id, st, path, err := s.K.GetAuditExport(ctx, meta(in.Meta), in.ExportId)
	if err != nil {
		return nil, toStatus(err)
	}
	return &v1.GetAuditExportResponse{Envelope: toEnv(env), ExportId: id, Status: st, DownloadPath: path}, nil
}

func (s *Server) GetSystemCapabilities(ctx context.Context, in *v1.GetCapabilitiesRequest) (*v1.GetCapabilitiesResponse, error) {
	return s.GetCapabilities(ctx, in)
}

func (s *Server) GetSystemHealth(ctx context.Context, in *v1.GetProfileRequest) (*v1.SystemHealthResponse, error) {
	err := s.K.DB.Ready(ctx, s.K.Cfg.RequiredMigration)
	ok := err == nil
	st := "ready"
	if !ok {
		st = "not_ready"
	}
	return &v1.SystemHealthResponse{Envelope: toEnv(s.KEnv(in.Meta)), Status: st, Database: ok, Migrations: ok}, nil
}

func (s *Server) ListProducts(ctx context.Context, in *v1.ListProductsRequest) (*v1.ListProductsResponse, error) {
	rows, err := s.K.Pool().Query(ctx, `SELECT product_id, name, brand, category, subcategory, canonical_description, lifecycle FROM products ORDER BY name LIMIT 200`)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListProductsResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		p := &v1.Product{}
		if err := rows.Scan(&p.ProductId, &p.Name, &p.Brand, &p.Category, &p.Subcategory, &p.CanonicalDescription, &p.Lifecycle); err != nil {
			return nil, err
		}
		resp.Products = append(resp.Products, p)
	}
	return resp, nil
}

func (s *Server) GetProductAdmin(ctx context.Context, in *v1.GetProductRequest) (*v1.GetProductResponse, error) {
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
	for skuRows.Next() {
		sku := &v1.Sku{}
		var price int64
		if err := skuRows.Scan(&sku.SkuId, &sku.ProductId, &sku.Name, &sku.Brand, &sku.Variant, &sku.Lifecycle, &price); err != nil {
			return nil, err
		}
		sku.SellingPrice = money(price, "INR")
		p.Skus = append(p.Skus, sku)
	}
	return &v1.GetProductResponse{Envelope: toEnv(s.KEnv(in.Meta)), Product: p}, nil
}

func (s *Server) ListRelationships(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListRelationshipsResponse, error) {
	rows, err := s.K.Pool().Query(ctx, `SELECT source_id, target_id, relationship_type FROM product_relationships LIMIT 500`)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListRelationshipsResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		r := &v1.Relationship{}
		if err := rows.Scan(&r.Source, &r.Target, &r.Type); err != nil {
			return nil, err
		}
		resp.Relationships = append(resp.Relationships, r)
	}
	return resp, nil
}

func (s *Server) ListPromotions(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListPromotionsResponse, error) {
	rows, err := s.K.Pool().Query(ctx, `SELECT promotion_id, name, type FROM promotions ORDER BY name LIMIT 200`)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListPromotionsResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		p := &v1.Promotion{}
		if err := rows.Scan(&p.PromotionId, &p.Name, &p.Type); err != nil {
			return nil, err
		}
		resp.Promotions = append(resp.Promotions, p)
	}
	return resp, nil
}

func (s *Server) ListStrategies(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListStrategiesResponse, error) {
	rows, err := s.K.ListStrategyConfigs(ctx)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListStrategiesResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for _, r := range rows {
		resp.Strategies = append(resp.Strategies, &v1.StrategyConfig{StrategyType: r.Type, Enabled: r.Enabled, Revision: r.Revision, Surfaces: r.Surfaces})
	}
	return resp, nil
}

func (s *Server) UpdateStrategies(ctx context.Context, in *v1.UpdateStrategiesRequest) (*v1.ListStrategiesResponse, error) {
	var rows []app.StrategyRow
	for _, st := range in.Strategies {
		rows = append(rows, app.StrategyRow{Type: st.StrategyType, Enabled: st.Enabled, Revision: st.Revision, Surfaces: st.Surfaces})
	}
	got, err := s.K.UpdateStrategyConfigs(ctx, meta(in.Meta), rows)
	if err != nil {
		return nil, toStatus(err)
	}
	resp := &v1.ListStrategiesResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for _, r := range got {
		resp.Strategies = append(resp.Strategies, &v1.StrategyConfig{StrategyType: r.Type, Enabled: r.Enabled, Revision: r.Revision, Surfaces: r.Surfaces})
	}
	return resp, nil
}

func (s *Server) PreviewRules(ctx context.Context, in *v1.PreviewRulesRequest) (*v1.PreviewRulesResponse, error) {
	tot, offers, err := s.K.PreviewRuleEconomics(ctx, meta(in.Meta))
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
		Offers: toOffers(offers),
	}, nil
}

func (s *Server) UpdatePromotion(ctx context.Context, in *v1.UpdatePromotionRequest) (*v1.ListPromotionsResponse, error) {
	if err := s.K.UpdatePromotionEnabled(ctx, meta(in.Meta), in.PromotionId, in.Enabled); err != nil {
		return nil, toStatus(err)
	}
	return s.ListPromotions(ctx, &v1.GetProfileRequest{Meta: in.Meta})
}

func (s *Server) ListSessions(ctx context.Context, in *v1.ListSessionsRequest) (*v1.ListSessionsResponse, error) {
	rows, err := s.K.Pool().Query(ctx, `SELECT s.session_id, s.session_context_version, s.location_id, s.status, c.cart_id, c.cart_version, COALESCE(s.planning_budget_minor,0), COALESCE(s.mission,''), COALESCE(c.currency,'INR'), COALESCE(c.all_in_total_minor,0)
		FROM shopping_sessions s LEFT JOIN carts c ON c.session_id=s.session_id
		ORDER BY s.updated_at DESC LIMIT 100`)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListSessionsResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		ss := &v1.SessionSummary{}
		var budget, total int64
		if err := rows.Scan(&ss.SessionId, &ss.SessionContextVersion, &ss.LocationId, &ss.Status, &ss.CartId, &ss.CartVersion, &budget, &ss.Mission, &ss.Currency, &total); err != nil {
			return nil, err
		}
		ss.PlanningBudget = money(budget, ss.Currency)
		resp.Sessions = append(resp.Sessions, ss)
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
	rows, err := s.K.Pool().Query(ctx, `SELECT offer_id, strategy_type, session_context_version, cart_version, expires_at, status, grounded_reason, terms, created_at, buyer_impact_minor FROM offers WHERE ($1='' OR session_id=$1) ORDER BY created_at DESC LIMIT 200`, in.SessionId)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListOffersResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		o := &v1.Offer{}
		var created, exp time.Time
		var impact int64
		if err := rows.Scan(&o.OfferId, &o.StrategyType, &o.SessionContextVersion, &o.CartVersion, &exp, &o.Status, &o.GroundedReason, &o.Terms, &created, &impact); err != nil {
			return nil, err
		}
		o.ExpiresAt = timestamppb.New(exp)
		o.BuyerImpact = money(impact, "INR")
		resp.Offers = append(resp.Offers, o)
	}
	return resp, nil
}

func (s *Server) GetOffer(ctx context.Context, in *v1.GetOfferRequest) (*v1.GetOfferResponse, error) {
	o := &v1.Offer{}
	var exp time.Time
	var impact int64
	var patch []byte
	err := s.K.Pool().QueryRow(ctx, `SELECT offer_id, strategy_type, session_context_version, cart_version, expires_at, status, grounded_reason, terms, cart_patch, buyer_impact_minor FROM offers WHERE offer_id=$1`, in.OfferId).
		Scan(&o.OfferId, &o.StrategyType, &o.SessionContextVersion, &o.CartVersion, &exp, &o.Status, &o.GroundedReason, &o.Terms, &patch, &impact)
	if err != nil {
		return nil, status.Error(codes.NotFound, "offer not found")
	}
	o.ExpiresAt = timestamppb.New(exp)
	o.BuyerImpact = money(impact, "INR")
	var p appPatch
	_ = json.Unmarshal(patch, &p)
	o.CartPatch = &v1.CartPatch{PatchType: p.Type, SourceCartLineId: p.SourceLineID, SourceSkuId: p.SourceSKUID, PromotionId: p.PromotionID, BundleId: p.BundleID}
	for _, l := range p.Lines {
		o.CartPatch.Lines = append(o.CartPatch.Lines, &v1.CartPatchLine{SkuId: l.SKUID, Quantity: int32(l.Quantity), Op: l.Op})
	}
	if p.Economics != nil && (p.Economics.ItemCostMinor != 0 || p.Economics.ThresholdGapMinor != 0 || p.Economics.FeeSavingMinor != 0) {
		o.Economics = &v1.OfferEconomics{
			ItemCostMinor:     p.Economics.ItemCostMinor,
			ThresholdGapMinor: p.Economics.ThresholdGapMinor,
			FeeSavingMinor:    p.Economics.FeeSavingMinor,
		}
	}
	return &v1.GetOfferResponse{Envelope: toEnv(s.KEnv(in.Meta)), Offer: o, CandidateJson: string(patch)}, nil
}

func (s *Server) ListOrders(ctx context.Context, in *v1.ListOrdersRequest) (*v1.ListOrdersResponse, error) {
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
	return resp, nil
}

func (s *Server) GetOrderAdmin(ctx context.Context, in *v1.GetOrderAdminRequest) (*v1.GetOrderResponse, error) {
	list, err := s.ListOrders(ctx, &v1.ListOrdersRequest{Meta: in.Meta})
	if err != nil {
		return nil, err
	}
	for _, o := range list.Orders {
		if o.MerchantOrderId == in.MerchantOrderId {
			return &v1.GetOrderResponse{Envelope: list.Envelope, Order: o}, nil
		}
	}
	return nil, status.Error(codes.NotFound, "order not found")
}

func (s *Server) ListHosts(ctx context.Context, in *v1.GetProfileRequest) (*v1.ListHostsResponse, error) {
	rows, err := s.K.Pool().Query(ctx, `SELECT host_id, display_name, status, scopes FROM approved_hosts ORDER BY host_id`)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListHostsResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		h := &v1.HostRecord{}
		var scopes []string
		if err := rows.Scan(&h.HostId, &h.DisplayName, &h.Status, &scopes); err != nil {
			return nil, err
		}
		h.Scopes = scopes
		resp.Hosts = append(resp.Hosts, h)
	}
	return resp, nil
}

func (s *Server) ListOperations(ctx context.Context, in *v1.ListOperationsRequest) (*v1.ListOperationsResponse, error) {
	rows, err := s.K.Pool().Query(ctx, `SELECT job_id, job_type, status, COALESCE(operation_id,'') FROM jobs ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		return nil, toStatus(err)
	}
	defer rows.Close()
	resp := &v1.ListOperationsResponse{Envelope: toEnv(s.KEnv(in.Meta))}
	for rows.Next() {
		j := &v1.JobRow{}
		if err := rows.Scan(&j.JobId, &j.JobType, &j.Status, &j.OperationId); err != nil {
			return nil, err
		}
		resp.Jobs = append(resp.Jobs, j)
	}
	return resp, nil
}

func (s *Server) ReconcileOperation(ctx context.Context, in *v1.ReconcileOperationRequest) (*v1.ReconcileOperationResponse, error) {
	return &v1.ReconcileOperationResponse{Envelope: toEnv(s.KEnv(in.Meta)), Scheduled: true}, nil
}

func (s *Server) UpdateMerchantProfile(ctx context.Context, in *v1.UpdateProfileRequest) (*v1.GetProfileResponse, error) {
	_, err := s.K.Pool().Exec(ctx, `UPDATE merchant_profile SET display_name=COALESCE(NULLIF($1,''), display_name), profile_version=profile_version+1, updated_at=now() WHERE singleton_key='singleton'`, in.DisplayName)
	if err != nil {
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

func toMut(out app.CartMutation) *v1.CartMutationResult {
	return &v1.CartMutationResult{Envelope: toEnv(out.Envelope), SessionSummary: toSession(out.Session), Cart: toCart(out.Cart), Offers: toOffers(out.Offers), InvalidatedOfferIds: out.InvalidatedOfferIDs}
}

func toEnv(e app.Envelope) *v1.Envelope {
	return &v1.Envelope{ContractVersion: e.ContractVersion, RequestId: e.RequestID, OccurredAt: timestamppb.New(e.OccurredAt), OperationId: e.OperationID}
}

func toAuditEvent(e app.AuditEventView) *v1.AuditEvent {
	return &v1.AuditEvent{
		AuditEventId: e.ID, RecordSequence: e.Sequence, EventKind: e.Kind, OccurredAt: e.OccurredAt, RequestId: e.RequestID,
		OperationId: e.OperationID, Action: e.Action, PrimaryResourceType: e.ResourceType, PrimaryResourceId: e.ResourceID,
		SummarySentence: e.Summary, AttentionCode: e.Attention, EventBodyJson: string(e.BodyJSON),
	}
}

func toSession(s app.SessionSummary) *v1.SessionSummary {
	ss := &v1.SessionSummary{SessionId: s.SessionID, SessionContextVersion: s.SessionContextVersion, LocationId: s.LocationID, Status: s.Status, CartId: s.CartID, CartVersion: s.CartVersion, Mission: s.Mission, Currency: s.Currency}
	if s.HasBudget {
		ss.PlanningBudget = &v1.Money{AmountMinor: s.PlanningBudgetMinor, Currency: s.Currency}
	}
	return ss
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

func toOffers(os []app.OfferView) []*v1.Offer {
	var out []*v1.Offer
	for _, o := range os {
		out = append(out, toOffer(o))
	}
	return out
}

func toOffer(o app.OfferView) *v1.Offer {
	var patch appPatch
	_ = json.Unmarshal(o.PatchJSON, &patch)
	p := &v1.CartPatch{PatchType: patch.Type, SourceCartLineId: patch.SourceLineID, SourceSkuId: patch.SourceSKUID, PromotionId: patch.PromotionID, BundleId: patch.BundleID}
	for _, l := range patch.Lines {
		p.Lines = append(p.Lines, &v1.CartPatchLine{SkuId: l.SKUID, Quantity: int32(l.Quantity), Op: l.Op})
	}
	out := &v1.Offer{OfferId: o.OfferID, StrategyType: o.StrategyType, SessionContextVersion: o.SessionContextVersion, CartVersion: o.CartVersion, ExpiresAt: timestamppb.New(o.ExpiresAt), Status: o.Status, GroundedReason: o.GroundedReason, Terms: o.Terms, CartPatch: p, BuyerImpact: money(o.BuyerImpactMinor, "INR"), BaseAllInTotal: money(o.BaseAllInMinor, "INR"), ProjectedAllInTotal: money(o.PatchedAllInMinor, "INR")}
	if patch.Economics != nil && (patch.Economics.ItemCostMinor != 0 || patch.Economics.ThresholdGapMinor != 0 || patch.Economics.FeeSavingMinor != 0) {
		out.Economics = &v1.OfferEconomics{
			ItemCostMinor:     patch.Economics.ItemCostMinor,
			ThresholdGapMinor: patch.Economics.ThresholdGapMinor,
			FeeSavingMinor:    patch.Economics.FeeSavingMinor,
		}
	}
	return out
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

func toSKU(s app.SKUView) *v1.Sku {
	return &v1.Sku{SkuId: s.SKUID, ProductId: s.ProductID, Name: s.Name, Brand: s.Brand, Variant: s.Variant, PackSize: s.PackSize, UnitOfMeasure: s.UOM, Barcode: s.Barcode, CanonicalDescription: s.Description, Lifecycle: s.Lifecycle, SellingPrice: money(s.SellingMinor, "INR"), SellableQuantity: s.Sellable, StockStatus: s.StockStatus, Assorted: s.Assorted}
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
		return status.Error(codes.Internal, err.Error())
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
	case apperr.RateLimited:
		code = codes.ResourceExhausted
	}
	st := status.New(code, e.Message)
	d := &v1.ErrorDetail{Code: e.Code, Message: e.Message, Retryable: e.Retryable, RetryAfterMs: e.RetryAfter, OperationId: e.Operation, Details: e.Details}
	if s, ok := e.Session.(app.SessionSummary); ok {
		d.CurrentSessionSummary = toSession(s)
	}
	if c, ok := e.Cart.(app.CartView); ok {
		d.CurrentCart = toCart(c)
	}
	st, _ = st.WithDetails(d)
	return st.Err()
}

func str(v any) string {
	s, _ := v.(string)
	return s
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
