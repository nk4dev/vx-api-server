import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { appRouter } from "./trpc-router";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

// tRPC routes
app.use("/trpc/*", trpcServer({ router: appRouter }));

// Health check endpoint
app.get("/", (c) => {
  return c.json({
    message: "VX API Server with tRPC",
    version: "0.1.3",
    status: "ok",
  });
});

app.get("/version", (c) => c.json({ version: "0.1.3" }));

export default app;
