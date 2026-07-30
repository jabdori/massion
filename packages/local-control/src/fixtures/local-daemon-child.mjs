import { createServer } from "node:http";

const port = Number(process.env.MASSION_HTTP_PORT);
const server = createServer((request, response) => {
  if (request.url === "/health/ready") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ready" }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
