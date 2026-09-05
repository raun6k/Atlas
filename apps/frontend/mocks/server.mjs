#!/usr/bin/env node
/**
 * Isolation-only neighbor stand-in. Join does not start the frontend-mocks profile.
 * Health-only process for frontend unit isolation; the merchant console talks to Gateway/AtlasLab.
 */
import http from "node:http";

const listen = process.env.ATLAS_MOCK_HTTP_ADDR ?? "127.0.0.1:18080";
const [host, portString] = listen.split(":");
const port = Number(portString);

const server = http.createServer((req, res) => {
  const path = req.url?.split("?")[0] ?? "/";
  if (path === "/health/live") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "live" }));
    return;
  }
  res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "frontend_isolation_mock", path }));
});

server.listen(port, host, () => {
  process.stdout.write(`frontend-mocks stub listening on ${host}:${port}\n`);
});
