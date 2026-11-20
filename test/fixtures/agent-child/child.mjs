// The fixture's declared child: one loopback port, no dependency.
import { createServer } from "node:http";

const version = "1.0.0";
if (process.argv[2] === "--version") {
  console.log(version);
} else {
  // The declaration's `env` must have reached this process.
  if (process.env.FIXTURE_CHILD_MODE !== "declared") {
    console.error("fixture child: started without its declared environment");
    process.exit(1);
  }
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(39111, "127.0.0.1");
  process.on("SIGTERM", () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
}
