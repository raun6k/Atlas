const fs = require("fs");
const path = require("path");
const tools = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../schemas/mcp/tools.json"), "utf8")).tools;
if (tools.length !== 13) throw new Error("expected 13 public tools");
for (const forbidden of ["get_session", "get_profile", "get_substitution", "respond_to_substitution", "accept_offer"]) {
  if (tools.includes(forbidden)) throw new Error(forbidden + " must not be public MCP");
}
for (const name of tools) {
  const disk = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../schemas/mcp", name + ".json"), "utf8"));
  if (disk.title !== name) throw new Error(name + " schema title mismatch");
  if (disk.type !== "object") throw new Error(name + " schema must be object");
  if (!disk.properties) throw new Error(name + " missing properties");
}
console.log("mcp contract schema: 13 tools match schemas/mcp");
