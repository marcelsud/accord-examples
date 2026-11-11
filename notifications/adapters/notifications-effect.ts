import { Effect } from "effect";
import { effectify } from "@marcelsud/accord/effect";
import { external, parse, unexpected } from "@marcelsud/accord";
import {
  Acknowledgement,
  NotificationConflict,
  NotificationsUnavailable,
  SendNotificationContract,
  type NotificationPort,
} from "../domain.js";

/** The same external-system contract, implemented with Effect. */
export function createNotifications(url: string): NotificationPort {
  const Send = external(
    "Bank/SendNotification",
    SendNotificationContract,
    effectify((input) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": encodeURIComponent(input.eventId),
              },
              body: JSON.stringify(input),
              signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
            }),
          catch: unexpected,
        });
        if (!response.ok) {
          yield* Effect.tryPromise({
            try: () => response.arrayBuffer(),
            catch: unexpected,
          });
          return yield* Effect.fail(
            response.status === 409
              ? NotificationConflict({ eventId: input.eventId })
              : NotificationsUnavailable(),
          );
        }
        const json: unknown = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: unexpected,
        });
        return parse(Acknowledgement, json);
      }),
    ),
  );
  return { send: Send.implement({}) };
}
