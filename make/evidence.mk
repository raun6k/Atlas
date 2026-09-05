# Evidence gates are intentionally separate: repository shape, live stack, and
# provider-backed commercial proof are different claims.

.PHONY: release-verify release-verify-static release-verify-runtime release-verify-commercial

release-verify:
	ATLAS_RELEASE_MODE=all node scripts/release-verify.mjs
	cd apps/frontend && ATLAS_FRONTEND_ENABLE_MOCKS=1 npm run test:e2e

release-verify-static:
	ATLAS_RELEASE_MODE=static node scripts/release-verify.mjs

release-verify-runtime:
	ATLAS_RELEASE_MODE=runtime node scripts/release-verify.mjs

release-verify-commercial:
	ATLAS_RELEASE_MODE=commercial node scripts/release-verify.mjs
