package app

import "testing"

func TestHostToolPermittedFailClosed(t *testing.T) {
	if !hostToolPermitted(nil, "get_capabilities") {
		t.Fatal("get_capabilities must remain unauthenticated")
	}
	if hostToolPermitted(nil, "search_catalog") {
		t.Fatal("empty scopes must deny search_catalog")
	}
	if hostToolPermitted([]string{}, "create_session") {
		t.Fatal("empty scopes must deny create_session")
	}
	if !hostToolPermitted([]string{"*"}, "complete_checkout") {
		t.Fatal("* must allow complete_checkout")
	}
	if !hostToolPermitted([]string{"mcp"}, "get_order") {
		t.Fatal("mcp must allow public tools")
	}
	if !hostToolPermitted([]string{"mcp:discover"}, "search_catalog") {
		t.Fatal("mcp:discover must allow search")
	}
	if hostToolPermitted([]string{"mcp:discover"}, "add_cart_item") {
		t.Fatal("mcp:discover must not allow cart mutation")
	}
	if !hostToolPermitted([]string{"mcp:commerce"}, "prepare_checkout") {
		t.Fatal("mcp:commerce must allow prepare_checkout")
	}
	if hostToolPermitted([]string{"mcp:commerce"}, "complete_checkout") {
		t.Fatal("mcp:commerce must not allow complete_checkout")
	}
	if !hostToolPermitted([]string{"mcp:payment"}, "get_order") {
		t.Fatal("mcp:payment must allow get_order")
	}
	if !hostToolPermitted([]string{"mcp:eval"}, "set_intent") {
		t.Fatal("mcp:eval must allow set_intent")
	}
}
