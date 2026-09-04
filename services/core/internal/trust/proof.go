package trust

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"atlas.dev/core/internal/apperr"

	"github.com/jackc/pgx/v5"
	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jws"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

type ProofClaims struct {
	HostID         string
	KeyID          string
	Tool           string
	RequestID      string
	IdempotencyKey string
	Nonce          string
	ArgDigest      string
	SessionID      string
	SessionVersion int64
	CartVersion    int64
	ExpiresAt      time.Time
}

type AuthorityClaims struct {
	HostID         string
	KeyID          string
	ProposalID     string
	QuoteHash      string
	AmountMinor    int64
	Currency       string
	Capability     string
	SessionID      string
	SessionVersion int64
	CartID         string
	CartVersion    int64
	Nonce          string
	ExpiresAt      time.Time
}

func VerifyHostProof(ctx context.Context, tx pgx.Tx, compact string, hostID, tool, requestID, idempotencyKey string, args map[string]any, now time.Time, audience string, ttl time.Duration) (ProofClaims, error) {
	if strings.TrimSpace(compact) == "" {
		return ProofClaims{}, apperr.New(apperr.HostForbidden, "host_request_proof is required")
	}
	tok, hdr, err := parseAndVerify(ctx, tx, compact, hostID, audience, now, ttl)
	if err != nil {
		return ProofClaims{}, err
	}
	c := ProofClaims{
		HostID:         hostID,
		KeyID:          hdr,
		Tool:           strClaim(tok, "tool"),
		RequestID:      strClaim(tok, "request_id"),
		IdempotencyKey: strClaim(tok, "idempotency_key"),
		Nonce:          tok.JwtID(),
		ArgDigest:      strClaim(tok, "arg_digest"),
		SessionID:      strClaim(tok, "session_id"),
		SessionVersion: intClaim(tok, "session_context_version"),
		CartVersion:    intClaim(tok, "cart_version"),
		ExpiresAt:      tok.Expiration(),
	}
	if c.Tool != tool || c.RequestID != requestID || c.IdempotencyKey != idempotencyKey {
		return ProofClaims{}, apperr.New(apperr.HostForbidden, "host request proof binding mismatch")
	}
	want, err := ArgDigest(args)
	if err != nil {
		return ProofClaims{}, err
	}
	if !strings.EqualFold(c.ArgDigest, want) {
		return ProofClaims{}, apperr.New(apperr.HostForbidden, "host request proof digest mismatch")
	}
	if err := consumeNonce(ctx, tx, hostID, c.Nonce, c.ExpiresAt); err != nil {
		return ProofClaims{}, err
	}
	return c, nil
}

func VerifyCheckoutAuthority(ctx context.Context, tx pgx.Tx, compact, hostID, proposalID, quoteHash, capability string, amountMinor int64, currency string, now time.Time, audience string, ttl time.Duration) (AuthorityClaims, error) {
	if strings.TrimSpace(compact) == "" {
		return AuthorityClaims{}, apperr.New(apperr.AuthorityInvalid, "checkout authority is required")
	}
	tok, kid, err := parseAndVerify(ctx, tx, compact, hostID, audience, now, ttl)
	if err != nil {
		mapped := apperr.As(err)
		if mapped != nil && mapped.Code == apperr.HostForbidden {
			if strings.Contains(mapped.Message, "expired") {
				return AuthorityClaims{}, apperr.New(apperr.AuthorityExpired, mapped.Message)
			}
			return AuthorityClaims{}, apperr.New(apperr.AuthorityInvalid, mapped.Message)
		}
		return AuthorityClaims{}, err
	}
	c := AuthorityClaims{
		HostID:         hostID,
		KeyID:          kid,
		ProposalID:     strClaim(tok, "checkout_proposal_id"),
		QuoteHash:      strClaim(tok, "quote_hash"),
		AmountMinor:    intClaim(tok, "amount_minor"),
		Currency:       strClaim(tok, "currency"),
		Capability:     strClaim(tok, "payment_capability_id"),
		SessionID:      strClaim(tok, "session_id"),
		SessionVersion: intClaim(tok, "session_context_version"),
		CartID:         strClaim(tok, "cart_id"),
		CartVersion:    intClaim(tok, "cart_version"),
		Nonce:          tok.JwtID(),
		ExpiresAt:      tok.Expiration(),
	}
	if now.After(c.ExpiresAt) {
		return AuthorityClaims{}, apperr.New(apperr.AuthorityExpired, "checkout authority expired")
	}
	if c.ProposalID != proposalID || c.QuoteHash != quoteHash {
		return AuthorityClaims{}, apperr.New(apperr.AuthorityInvalid, "authority does not match proposal")
	}
	if c.Capability != capability {
		return AuthorityClaims{}, apperr.New(apperr.AuthorityInvalid, "authority capability mismatch")
	}
	if c.Currency != currency {
		return AuthorityClaims{}, apperr.New(apperr.AuthorityInvalid, "authority currency mismatch")
	}
	if c.AmountMinor > amountMinor {
		return AuthorityClaims{}, apperr.New(apperr.AuthorityAmountExceeded, "authority amount exceeds proposal")
	}
	if c.AmountMinor != amountMinor {
		return AuthorityClaims{}, apperr.New(apperr.AuthorityInvalid, "authority amount mismatch")
	}
	if err := consumeNonce(ctx, tx, hostID, "ca:"+c.Nonce, c.ExpiresAt); err != nil {
		return AuthorityClaims{}, err
	}
	return c, nil
}

func parseAndVerify(ctx context.Context, tx pgx.Tx, compact, hostID, audience string, now time.Time, ttl time.Duration) (jwt.Token, string, error) {
	msg, err := jws.Parse([]byte(compact))
	if err != nil {
		return nil, "", apperr.New(apperr.HostForbidden, "invalid host signature")
	}
	if len(msg.Signatures()) == 0 {
		return nil, "", apperr.New(apperr.HostForbidden, "invalid host signature")
	}
	kid := msg.Signatures()[0].ProtectedHeaders().KeyID()
	alg := msg.Signatures()[0].ProtectedHeaders().Algorithm()
	if alg != jwa.ES256 {
		return nil, "", apperr.New(apperr.HostForbidden, "algorithm not allowed")
	}
	var status string
	var jwkRaw []byte
	err = tx.QueryRow(ctx, `SELECT status, public_jwk FROM host_keys WHERE host_id=$1 AND key_id=$2`, hostID, kid).Scan(&status, &jwkRaw)
	if err != nil {
		return nil, "", apperr.New(apperr.HostForbidden, "unknown host key")
	}
	if status != "ACTIVE" {
		return nil, "", apperr.New(apperr.HostForbidden, "host key is not active")
	}
	key, err := jwk.ParseKey(jwkRaw)
	if err != nil {
		return nil, "", apperr.New(apperr.HostForbidden, "host key is invalid")
	}
	tok, err := jwt.Parse([]byte(compact), jwt.WithKey(jwa.ES256, key), jwt.WithValidate(false))
	if err != nil {
		return nil, "", apperr.New(apperr.HostForbidden, "invalid host signature")
	}
	if tok.Audience() == nil || !contains(tok.Audience(), audience) {
		return nil, "", apperr.New(apperr.HostForbidden, "invalid audience")
	}
	if tok.JwtID() == "" {
		return nil, "", apperr.New(apperr.HostForbidden, "missing nonce")
	}
	if tok.Expiration().IsZero() || now.After(tok.Expiration()) {
		return nil, "", apperr.New(apperr.HostForbidden, "host proof expired")
	}
	if !tok.IssuedAt().IsZero() && tok.Expiration().Sub(tok.IssuedAt()) > ttl+time.Second {
		return nil, "", apperr.New(apperr.HostForbidden, "host proof ttl exceeded")
	}
	return tok, kid, nil
}

func consumeNonce(ctx context.Context, tx pgx.Tx, hostID, nonce string, exp time.Time) error {
	tag, err := tx.Exec(ctx, `INSERT INTO replay_nonces (host_id, nonce, expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, hostID, nonce, exp)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apperr.New(apperr.HostForbidden, "replay nonce already consumed")
	}
	return nil
}

func ArgDigest(args map[string]any) (string, error) {
	canon, err := CanonicalJSON(args)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canon)
	return hex.EncodeToString(sum[:]), nil
}

func ArtifactDigest(compact string) string {
	sum := sha256.Sum256([]byte(compact))
	return hex.EncodeToString(sum[:])
}

func CanonicalJSON(v any) ([]byte, error) {
	n, err := normalize(v)
	if err != nil {
		return nil, err
	}
	return marshalJCS(n)
}

func normalize(v any) (any, error) {
	switch t := v.(type) {
	case nil:
		return nil, nil
	case bool, string:
		return t, nil
	case json.Number:
		return json.Number(t), nil
	case int:
		return json.Number(fmt.Sprintf("%d", t)), nil
	case int32:
		return json.Number(fmt.Sprintf("%d", t)), nil
	case int64:
		return json.Number(fmt.Sprintf("%d", t)), nil
	case float64:
		if t == float64(int64(t)) {
			return json.Number(fmt.Sprintf("%d", int64(t))), nil
		}
		return json.Number(fmt.Sprintf("%g", t)), nil
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			nv, err := normalize(val)
			if err != nil {
				return nil, err
			}
			out[k] = nv
		}
		return out, nil
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			nv, err := normalize(val)
			if err != nil {
				return nil, err
			}
			out[i] = nv
		}
		return out, nil
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return nil, err
		}
		var generic any
		dec := json.NewDecoder(strings.NewReader(string(b)))
		dec.UseNumber()
		if err := dec.Decode(&generic); err != nil {
			return nil, err
		}
		return normalize(generic)
	}
}

func marshalJCS(v any) ([]byte, error) {
	switch t := v.(type) {
	case nil:
		return []byte("null"), nil
	case bool:
		if t {
			return []byte("true"), nil
		}
		return []byte("false"), nil
	case string:
		b, err := json.Marshal(t)
		return b, err
	case json.Number:
		return []byte(string(t)), nil
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b strings.Builder
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			b.Write(kb)
			b.WriteByte(':')
			vb, err := marshalJCS(t[k])
			if err != nil {
				return nil, err
			}
			b.Write(vb)
		}
		b.WriteByte('}')
		return []byte(b.String()), nil
	case []any:
		var b strings.Builder
		b.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			vb, err := marshalJCS(item)
			if err != nil {
				return nil, err
			}
			b.Write(vb)
		}
		b.WriteByte(']')
		return []byte(b.String()), nil
	default:
		return json.Marshal(t)
	}
}

func strClaim(tok jwt.Token, key string) string {
	v, ok := tok.Get(key)
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

func intClaim(tok jwt.Token, key string) int64 {
	v, ok := tok.Get(key)
	if !ok {
		return 0
	}
	switch t := v.(type) {
	case float64:
		return int64(t)
	case json.Number:
		n, _ := t.Int64()
		return n
	case int64:
		return t
	default:
		return 0
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func B64Digest(compact string) string {
	sum := sha256.Sum256([]byte(compact))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
