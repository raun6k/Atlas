const fs = require("fs");
const path = require("path");
const proto = fs.readFileSync(path.join(__dirname, "../../../proto/atlas/merchant/v1/merchant.proto"), "utf8");
for (const rpc of ["CompleteCheckout", "GetOrder", "IngestProviderWebhook", "ClaimRunnerJob", "ReportRunnerObservation"]) {
  if (!proto.includes("rpc " + rpc)) throw new Error("missing frozen rpc " + rpc);
}
if (!proto.includes("rpc GetSession") || !proto.includes("rpc GetProfile") || !proto.includes("rpc GetSubstitution")) {
  throw new Error("admin/internal methods missing");
}
console.log("grpc frozen signatures: ok");
