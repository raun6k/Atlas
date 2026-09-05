package audit

import "strings"

const (
	ChannelMCP            = "MCP"
	ChannelAdmin          = "ADMIN"
	ChannelPaymentFabric  = "PAYMENT_FABRIC"
	ChannelPaymentRunner  = "PAYMENT_RUNNER"
	ChannelWebhook        = "WEBHOOK"
	ChannelAtlasLab       = "ATLASLAB"
	ChannelFixtureControl = "FIXTURE_CONTROL"
	ChannelSystem         = "SYSTEM"
)

const (
	PrincipalApprovedHost = "APPROVED_HOST"
	PrincipalOperator     = "OPERATOR"
	PrincipalSystem       = "ATLAS_SYSTEM"
	PrincipalFixture      = "FIXTURE_CONTROL"
	PrincipalWebhook      = "WEBHOOK"
	PrincipalRunner       = "PAYMENT_RUNNER"
)

var channelAliases = map[string]string{
	"mcp":              ChannelMCP,
	"admin":            ChannelAdmin,
	"payment":          ChannelPaymentFabric,
	"payment_fabric":   ChannelPaymentFabric,
	"payment-fabric":   ChannelPaymentFabric,
	"runner":           ChannelPaymentRunner,
	"payment_runner":   ChannelPaymentRunner,
	"webhook":          ChannelWebhook,
	"atlaslab":         ChannelAtlasLab,
	"lab":              ChannelAtlasLab,
	"fixture":          ChannelFixtureControl,
	"fixture_control":  ChannelFixtureControl,
	"fixture-control":  ChannelFixtureControl,
	"system":           ChannelSystem,
	"atlas_system":     ChannelSystem,
}

func CanonicalChannel(ch string) string {
	key := strings.ToLower(strings.TrimSpace(ch))
	if key == "" {
		return ChannelSystem
	}
	if mapped, ok := channelAliases[key]; ok {
		return mapped
	}
	switch strings.ToUpper(key) {
	case ChannelMCP, ChannelAdmin, ChannelPaymentFabric, ChannelPaymentRunner, ChannelWebhook, ChannelAtlasLab, ChannelFixtureControl, ChannelSystem:
		return strings.ToUpper(key)
	default:
		return ChannelSystem
	}
}

func CanonicalPrincipal(t string) string {
	switch strings.ToUpper(strings.TrimSpace(t)) {
	case PrincipalApprovedHost, "HOST":
		return PrincipalApprovedHost
	case PrincipalOperator:
		return PrincipalOperator
	case PrincipalFixture, "FIXTURE":
		return PrincipalFixture
	case PrincipalWebhook:
		return PrincipalWebhook
	case PrincipalRunner:
		return PrincipalRunner
	default:
		return PrincipalSystem
	}
}

func Merge(dst map[string]string, src map[string]string) map[string]string {
	if dst == nil {
		dst = map[string]string{}
	}
	for k, v := range src {
		if strings.TrimSpace(v) == "" {
			continue
		}
		dst[k] = v
	}
	return dst
}
