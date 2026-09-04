import { startServer } from "./app.js";

const { server, runtime } = await startServer();
const addr = server.address();
console.log(`atlaslab listening on ${typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : runtime.cfg.httpAddr}`);
