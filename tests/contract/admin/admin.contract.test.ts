const fs = require("fs");
const path = require("path");
const yaml = fs.readFileSync(path.join(__dirname, "../../../schemas/openapi/admin.yaml"), "utf8");
if (!yaml.includes("/admin/v1/merchant/profile")) throw new Error("missing profile");
if (!yaml.includes("/admin/v1/trust/attention")) throw new Error("missing attention");
if (!yaml.includes("/admin/v1/audit/exports")) throw new Error("missing export");
console.log("admin openapi contract: ok");
