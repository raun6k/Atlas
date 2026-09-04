const fs = require("fs");
const path = require("path");
const tools = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../schemas/mcp/tools.json"), "utf8")).tools;
if (tools.length !== 15) throw new Error("expected 15 public tools");
for (const forbidden of ["get_session", "get_profile", "get_substitution"]) {
  if (tools.includes(forbidden)) throw new Error(forbidden + " must not be public MCP");
}
console.log("mcp contract schema: 15 tools ok");
