import { external, fail, parse, trycatch } from "@marcelsud/accord";
import {
  Acknowledgement,
  NotificationConflict,
  NotificationsUnavailable,
  SendNotificationContract,
  type NotificationPort,
} from "../domain.js";

/** The domain sees a notification system; this adapter owns its HTTP protocol. */
export function createNotifications(url: string): NotificationPort {
  const Send = external(
    "Bank/SendNotification",
    SendNotificationContract,
    async (input, { signal }) => {
      const [response, error] = await trycatch(() =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": encodeURIComponent(input.eventId),
          },
          body: JSON.stringify(input),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
            : AbortSignal.timeout(5_000),
        }),
      );
      if (error !== null) return fail(error);
      if (!response.ok) {
        const [, bodyError] = await trycatch(() => response.arrayBuffer());
        if (bodyError !== null) return fail(bodyError);
        return fail(
          response.status === 409
            ? NotificationConflict({ eventId: input.eventId })
            : NotificationsUnavailable(),
        );
      }
      return trycatch(async () =>
        parse(Acknowledgement, await response.json()),
      );
    },
  );
  return { send: Send.implement({}) };
}
