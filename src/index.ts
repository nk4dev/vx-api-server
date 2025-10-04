import { httpServerHandler } from "cloudflare:node";
import { createServer } from "node:http";

const runnerPortNumber: number = 8080;

// Create your Node.js HTTP server
const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>VX API SERVER</h1>");
  } else if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
  } else if (req.url === "/version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "0.1.2" }));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(runnerPortNumber);

// Export the server as a Workers handler
export default httpServerHandler({ port: runnerPortNumber });
