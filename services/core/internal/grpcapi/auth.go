package grpcapi

import (
	"context"
	"strings"

	"atlas.dev/core/internal/app"
	"atlas.dev/core/internal/apperr"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type identityKey struct{}

type identity struct {
	Kind           string
	HostID         string
	OperatorID     string
	OperatorScopes []string
}

func IdentityFrom(ctx context.Context) *identity {
	id, _ := ctx.Value(identityKey{}).(*identity)
	return id
}

func withIdentity(ctx context.Context, id identity) context.Context {
	return context.WithValue(ctx, identityKey{}, &id)
}

func bearerFromMD(ctx context.Context) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	for _, key := range []string{"authorization", "Authorization"} {
		vals := md.Get(key)
		if len(vals) == 0 {
			continue
		}
		h := vals[0]
		if len(h) > 7 && strings.EqualFold(h[:7], "Bearer ") {
			return strings.TrimSpace(h[7:])
		}
		return strings.TrimSpace(h)
	}
	return ""
}

func methodClass(fullMethod string) string {
	switch {
	case strings.Contains(fullMethod, "/GetCapabilities"):
		return "public"
	case strings.Contains(fullMethod, "PaymentFabricService"):
		return "payment"
	case strings.Contains(fullMethod, "FixtureService"):
		return "fixture"
	case strings.Contains(fullMethod, "WorkerService"):
		return "worker"
	case strings.Contains(fullMethod, "AdminService"), strings.Contains(fullMethod, "AuditService"):
		return "operator"
	default:
		return "host"
	}
}

// UnaryAuth authenticates gRPC callers and never trusts operator_id/scopes from the request body.
func UnaryAuth(k *app.Kernel, runnerCred, webhookSecret, fabricBearer, workerCred string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		class := methodClass(info.FullMethod)
		token := bearerFromMD(ctx)
		switch class {
		case "public":
			if token != "" {
				if hostID, err := k.AuthenticateHostBearer(ctx, token); err == nil {
					ctx = withIdentity(ctx, identity{Kind: "host", HostID: hostID})
				}
			}
		case "host":
			hostID, err := k.AuthenticateHostBearer(ctx, token)
			if err != nil {
				return nil, status.Error(codes.Unauthenticated, apperr.HostUnauthenticated)
			}
			ctx = withIdentity(ctx, identity{Kind: "host", HostID: hostID})
		case "operator":
			id, scopes, err := k.AuthenticateOperator(ctx, token)
			if err != nil {
				return nil, status.Error(codes.Unauthenticated, apperr.Unauthenticated)
			}
			ctx = withIdentity(ctx, identity{Kind: "operator", OperatorID: id, OperatorScopes: scopes})
		case "fixture":
			if err := k.AuthenticateFixtureControl(ctx, token); err != nil {
				return nil, status.Error(codes.Unauthenticated, apperr.Unauthenticated)
			}
			ctx = withIdentity(ctx, identity{Kind: "fixture"})
		case "payment":
			if !paymentTokenOK(info.FullMethod, token, runnerCred, webhookSecret, fabricBearer) {
				return nil, status.Error(codes.Unauthenticated, apperr.Unauthenticated)
			}
			ctx = withIdentity(ctx, identity{Kind: "payment"})
		case "worker":
			if workerCred == "" || token != workerCred {
				return nil, status.Error(codes.Unauthenticated, apperr.Unauthenticated)
			}
			ctx = withIdentity(ctx, identity{Kind: "worker"})
		}
		return handler(ctx, req)
	}
}

func paymentTokenOK(fullMethod, token, runnerCred, webhookSecret, fabricBearer string) bool {
	if token == "" {
		return false
	}
	if strings.Contains(fullMethod, "IngestProviderWebhook") {
		return (webhookSecret != "" && token == webhookSecret) || (fabricBearer != "" && token == fabricBearer)
	}
	return runnerCred != "" && token == runnerCred
}
