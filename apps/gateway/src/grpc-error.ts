import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as grpc from "@grpc/grpc-js";
import { snake } from "./mcp-map.js";

const require = createRequire(import.meta.url);
const protobuf = require("protobufjs") as typeof import("protobufjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const protoPath = join(__dirname, "../../../proto/atlas/merchant/v1/merchant.proto");

let statusType: { decode: (buf: Uint8Array) => { details?: Array<{ type_url?: string; value?: Uint8Array }> } } | undefined;
let errorDetailType: { decode: (buf: Uint8Array) => unknown; toObject: (msg: unknown, opts: object) => Record<string, unknown> } | undefined;

function codecs() {
  if (statusType && errorDetailType) return { statusType, errorDetailType };
  const root = new protobuf.Root();
  const pbjsRoot = dirname(require.resolve("protobufjs/package.json"));
  root.resolvePath = (origin: string, target: string) => {
    if (target.endsWith("google/protobuf/timestamp.proto") || target === "google/protobuf/timestamp.proto") {
      return join(pbjsRoot, "google/protobuf/timestamp.proto");
    }
    return protobuf.util.path.resolve(origin, target);
  };
  root.loadSync(protoPath);
  const pbNs = root.define("google.protobuf");
  if (!root.lookupType("google.protobuf.Any")) {
    pbNs.add(new protobuf.Type("Any").add(new protobuf.Field("type_url", 1, "string")).add(new protobuf.Field("value", 2, "bytes")));
  }
  const rpcNs = root.define("google.rpc");
  if (!root.lookupType("google.rpc.Status")) {
    rpcNs.add(
      new protobuf.Type("Status")
        .add(new protobuf.Field("code", 1, "int32"))
        .add(new protobuf.Field("message", 2, "string"))
        .add(new protobuf.Field("details", 3, "google.protobuf.Any", "repeated")),
    );
  }
  statusType = root.lookupType("google.rpc.Status") as typeof statusType;
  errorDetailType = root.lookupType("atlas.merchant.v1.ErrorDetail") as typeof errorDetailType;
  return { statusType: statusType!, errorDetailType: errorDetailType! };
}

export function inferAtlasCode(message: string): string | undefined {
  if (/\b[A-Z][A-Z0-9_]{2,}\b/.test(message)) {
    const named = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0];
    if (named && named !== "MCP") return named;
  }
  const lower = message.toLowerCase();
  if (lower.includes("stale cart version")) return "CART_VERSION_CONFLICT";
  if (lower.includes("proposal is not active") || lower.includes("proposal expired")) return "REQUOTE_REQUIRED";
  if (lower.includes("host request proof digest mismatch") || lower.includes("host request proof")) return "HOST_FORBIDDEN";
  return undefined;
}

export function decodeAtlasErrorDetail(err: { metadata?: grpc.Metadata }): Record<string, unknown> | undefined {
  const md = err.metadata;
  if (!md || typeof md.get !== "function") return undefined;
  const bins = md.get("grpc-status-details-bin");
  if (!bins?.length) return undefined;
  const first = bins[0] as Buffer | Uint8Array | string;
  const buf = Buffer.isBuffer(first) ? first : Buffer.from(first as string);
  try {
    const { statusType: st, errorDetailType: ed } = codecs();
    const decoded = st.decode(buf);
    for (const any of decoded.details ?? []) {
      const url = String(any.type_url ?? "");
      if (!url.endsWith("ErrorDetail") || !any.value) continue;
      return ed.toObject(ed.decode(any.value), { longs: Number, defaults: false, enums: String, bytes: String });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function redactInternal(text: string): string {
  return text
    .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "[redacted-db]")
    .replace(/\b(rzp_test_|rzp_live_)[A-Za-z0-9]+/g, "[redacted-key]")
    .replace(/(\/[\w.-]+){2,}\.(go|ts|sql|key|pem)/g, "[redacted-path]")
    .replace(/(password|secret|authorization)=\S+/gi, "$1=[redacted]");
}

export function publicAdminError(err: { code?: number | string; message?: string; details?: string; metadata?: grpc.Metadata }, requestId: string): {
  code: string;
  request_id: string;
} {
  const detail = decodeAtlasErrorDetail(err);
  const raw = String(err.details || err.message || "");
  const code =
    (typeof detail?.code === "string" && detail.code) ||
    inferAtlasCode(raw) ||
    (err.code === 12 ? "UNIMPLEMENTED" : "UPSTREAM");
  console.log(JSON.stringify({ msg: "admin upstream error", request_id: requestId, code, grpc_code: err.code }));
  return { code, request_id: requestId };
}

export function mcpRpcError(err: { message?: string; details?: string; metadata?: grpc.Metadata }): {
  code: number;
  message: string;
  data?: unknown;
} {
  const human = redactInternal(String(err.details || err.message || "MCP tool call failed"));
  const detail = decodeAtlasErrorDetail(err);
  const atlasCode = (typeof detail?.code === "string" && detail.code) || inferAtlasCode(human) || "TEMPORARILY_UNAVAILABLE";
  const safeDetail = detail ? { ...(snake(detail) as Record<string, unknown>), code: atlasCode } : { code: atlasCode };
  return { code: -32000, message: atlasCode, data: safeDetail };
}
