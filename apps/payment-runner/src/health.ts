import { createServer } from "node:http";

export function startHealthServer(addr: string): ReturnType<typeof createServer> {
  const [host, portRaw] = addr.includes(":") ? addr.split(":") : ["127.0.0.1", addr];
  const port = Number(portRaw);
  const server = createServer((req, res) => {
    if (req.url === "/health/live" || req.url === "/health/ready") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", process: "payment-runner" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, host);
  return server;
}
