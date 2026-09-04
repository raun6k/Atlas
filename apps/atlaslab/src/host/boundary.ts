import { newPrefixedId } from "../ids.js";
import { redactUnknown } from "../redaction.js";
import { argumentDigest, redactedProofPreview, signCheckoutAuthority, signHostRequestProof, type HostSignerConfig } from "./signer.js";
import type { LabStore } from "../db/store.js";
import type { McpCallResult, McpClient } from "../mcp/client.js";
import { assertPublicTool } from "../mcp/client.js";
import { LabError, MUTATING_TOOLS, type ConsentPolicy, type PublicMcpTool, type PublicState, type RunRecord } from "../types.js";

export interface HostBoundaryInput {
  run: RunRecord;
  tool: string;
  arguments: Record<string, unknown>;
  proposedBy: "DETERMINISTIC_DRIVER" | "MODEL_VISIBLE";
  idempotencyKey?: string;
  permittedActions: PublicMcpTool[];
  consent: ConsentPolicy;
  publicState: PublicState;
  extraSecrets: string[];
}

export class HostBoundary {
  private retainedKeys = new Map<string, string>();

  constructor(
    private readonly signer: HostSignerConfig,
    private readonly mcp: McpClient,
    private readonly store: LabStore,
    private readonly hostBearer: string,
  ) {}

  retainKey(scope: string, key: string): void {
    this.retainedKeys.set(scope, key);
  }

  keyFor(scope: string): string | undefined {
    return this.retainedKeys.get(scope);
  }

  async invoke(input: HostBoundaryInput): Promise<McpCallResult> {
    assertPublicTool(input.tool);
    if (!input.permittedActions.includes(input.tool)) {
      const rejection = { tool: input.tool, reason: "action not permitted for this run" };
      await this.store.appendEvent({
        run_id: input.run.run_id,
        source: "HOST_BOUNDARY",
        kind: "SIGNER_REJECTED",
        payload: rejection,
      });
      throw new LabError("SIGNER_REJECTED", "request exceeds the run allowed action set");
    }
    if (input.publicState.effectful_payment_frozen && ["complete_checkout", "prepare_checkout"].includes(input.tool)) {
      throw new LabError("OUTCOME_UNKNOWN", "effectful payment tools frozen pending reconciliation");
    }

    const mutating = MUTATING_TOOLS.has(input.tool);
    const requestId = newPrefixedId("req");
    const scope = `${input.run.run_id}:${input.tool}:${JSON.stringify(input.arguments)}`;
    const idempotencyKey = mutating
      ? (input.idempotencyKey ?? this.retainedKeys.get(scope) ?? newPrefixedId("idem"))
      : undefined;
    if (mutating && idempotencyKey) this.retainedKeys.set(scope, idempotencyKey);

    const proposed = redactUnknown(input.arguments, input.extraSecrets) as Record<string, unknown>;
    await this.store.appendEvent({
      run_id: input.run.run_id,
      source: input.proposedBy,
      kind: "TOOL_PROPOSED",
      payload: { tool: input.tool, arguments: proposed, request_id: requestId },
    });

    let proof: string | undefined;
    let authority: string | undefined;
    const args = { ...input.arguments };
    if (input.tool === "create_session") {
      delete args.evaluation_arm;
      if (input.run.arm === "CONTROL" || input.run.arm === "TREATMENT") {
        args.evaluation_arm = input.run.arm;
      }
    }
    if (mutating) {
      proof = await signHostRequestProof({
        signer: this.signer,
        requestId,
        tool: input.tool,
        args,
        idempotencyKey: idempotencyKey!,
        sessionContextVersion: input.publicState.session_context_version,
        cartVersion: input.publicState.cart_version,
      });
      await this.store.appendEvent({
        run_id: input.run.run_id,
        source: "HOST_BOUNDARY",
        kind: "PROOF_SIGNED",
        payload: {
          tool: input.tool,
          request_id: requestId,
          idempotency_key: idempotencyKey,
          host_request_proof: redactedProofPreview(proof),
          arg_digest: argumentDigest(args),
        },
      });
    }
    if (input.tool === "complete_checkout") {
      const proposal = (args.checkout_proposal as Record<string, unknown> | undefined) ??
        (input.publicState.checkout_proposal as Record<string, unknown> | undefined);
      if (!proposal) throw new LabError("SIGNER_REJECTED", "missing checkout proposal");
      try {
        authority = await signCheckoutAuthority({
          signer: this.signer,
          consent: input.consent,
          proposal: proposal as never,
          opaqueConsentRef: `consent_${input.run.run_id}`,
        });
      } catch (err) {
        await this.store.appendEvent({
          run_id: input.run.run_id,
          source: "HOST_BOUNDARY",
          kind: "SIGNER_REJECTED",
          payload: { reason: err instanceof Error ? err.message : "signer rejected" },
        });
        throw err;
      }
      args.checkout_authority = "[REDACTED]";
    }

    const started = Date.now();
    const result = await this.mcp.call({
      tool: input.tool,
      arguments: {
        ...args,
        ...(authority ? { checkout_authority: authority } : {}),
      },
      requestId,
      idempotencyKey,
      hostRequestProof: proof,
      checkoutAuthority: authority,
      hostBearer: this.hostBearer,
    });
    const safeResponse = redactUnknown(result.payload, input.extraSecrets) as Record<string, unknown>;
    await this.store.appendEvent({
      run_id: input.run.run_id,
      source: "ATLAS_RESPONSE",
      kind: "TOOL_RESULT",
      payload: {
        tool: input.tool,
        request_id: result.requestId,
        result_code: result.resultCode,
        response: safeResponse,
      },
    });
    await this.store.insertToolExchange({
      tool_exchange_id: newPrefixedId("tex"),
      run_id: input.run.run_id,
      tool_name: input.tool,
      canonical_argument_digest: argumentDigest(input.arguments),
      idempotency_key: idempotencyKey ?? null,
      request_status: "SENT",
      result_status: result.resultCode,
      latency_ms: Date.now() - started,
      atlas_ids: {
        request_id: result.requestId,
        session_id: result.publicStatePatch.session_id,
        cart_id: result.publicStatePatch.cart_id,
        order_id: (result.publicStatePatch.order as { order_id?: string } | undefined)?.order_id,
      },
      proposed_arguments: proposed,
      host_enriched_request: {
        request_id: requestId,
        host_request_proof: proof ? redactedProofPreview(proof) : null,
        checkout_authority: authority ? redactedProofPreview(authority) : null,
      },
      atlas_response: safeResponse,
      returned_to_driver: { result_code: result.resultCode },
    });
    return result;
  }
}
