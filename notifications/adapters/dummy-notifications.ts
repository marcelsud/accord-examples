import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { parse, trycatch, type Infer } from "@marcelsud/accord";
import { Notification } from "../domain.js";

/** A loopback HTTP service that deduplicates accepted notifications by idempotency key. */
export async function startDummyNotifications(
  options: { failFirstAfterAccept?: boolean } = {},
) {
  const received = new Map<
    string,
    { id: string; notification: Infer<typeof Notification> }
  >();
  let attempts = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/notifications") {
      response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: "Missing idempotency key" }));
      return;
    }
    const [notification, error] = await trycatch(async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 16_384) throw new Error("Request too large");
        chunks.push(buffer);
      }
      return parse(
        Notification,
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
    });
    if (error !== null) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: "Invalid notification" }));
      return;
    }
    attempts++;
    const previous = received.get(key);
    if (previous && !isDeepStrictEqual(previous.notification, notification)) {
      response
        .writeHead(409)
        .end(JSON.stringify({ error: "Conflicting idempotency key" }));
      return;
    }
    const accepted = previous ?? {
      id: `notification-${received.size + 1}`,
      notification,
    };
    received.set(key, accepted);
    // Simulate a failed response after the remote side effect has already happened.
    if (options.failFirstAfterAccept && attempts === 1) {
      response.writeHead(503).end(JSON.stringify({ error: "Try again" }));
      return;
    }
    response.end(JSON.stringify({ id: accepted.id }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await server[Symbol.asyncDispose]();
    throw new Error("Expected a TCP listener");
  }
  return {
    url: `http://127.0.0.1:${address.port}/notifications`,
    received: received as ReadonlyMap<
      string,
      { id: string; notification: Infer<typeof Notification> }
    >,
    get attempts() {
      return attempts;
    },
    async [Symbol.asyncDispose]() {
      await server[Symbol.asyncDispose]();
    },
  };
}
