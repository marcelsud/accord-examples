import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBank as createPureBank } from "../notifications/pure.js";
import { createBank as createEffectBank } from "../notifications/with-effect.js";
import { startDummyNotifications } from "../notifications/adapters/dummy-notifications.js";
import { createNotifications as createPureNotifications } from "../notifications/adapters/notifications.js";
import { createNotifications as createEffectNotifications } from "../notifications/adapters/notifications-effect.js";
import { ok } from "@marcelsud/accord";
import {
  Deposited,
  NotificationConflict,
  NotificationsUnavailable,
  type NotificationPort,
} from "../notifications/domain.js";
import { openLedger } from "../notifications/adapters/sqlite.js";
import { failure, success } from "./helpers.js";

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "accord-notifications-"));
  return {
    filename: join(directory, "ledger.sqlite"),
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const [mode, createBank, createNotifications] of [
  ["pure", createPureBank, createPureNotifications],
  ["effect", createEffectBank, createEffectNotifications],
] as const) {
  test(`${mode}: the domain accepts a fake external notification system`, async () => {
    using ledger = openLedger();
    const sent: string[] = [];
    const notifications: NotificationPort = {
      async send(input) {
        sent.push(input.eventId);
        return ok({ id: `fake-${sent.length}` });
      },
    };
    const { bank } = createBank(ledger, notifications);
    success(await bank.account.open("a-1"));
    const receipt = success(await bank.account.deposit("a-1", 100));
    success(await bank.flush());
    assert.deepEqual(sent, [receipt.events[0]!.id]);
    assert.equal(success(ledger.list()).length, 1);
  });

  test(`${mode}: SQLite projection persists, replay upserts, and notification policy sends once`, async () => {
    const accountId = "a-1-💸";
    using temporary = temporaryDatabase();
    await using notificationSystem = await startDummyNotifications();
    {
      using ledger = openLedger(temporary.filename);
      const { bank, projection } = createBank(
        ledger,
        createNotifications(notificationSystem.url),
      );
      success(await bank.account.open(accountId));
      const receipt = success(await bank.account.deposit(accountId, 100));
      assert.deepEqual(success(ledger.list()), []);
      success(await bank.flush());
      const rows = success(ledger.list(accountId));
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        eventId: receipt.events[0]!.id,
        accountId: accountId,
        seq: 2,
        amount: 100,
        balance: 100,
      });
      assert.equal(notificationSystem.received.size, 1);
      assert.equal(
        notificationSystem.received.get(
          encodeURIComponent(receipt.events[0]!.id),
        )?.notification.balance,
        100,
      );

      // Replaying the projection writes the same event ID, without incrementing a total.
      const replay = receipt.events.map((envelope) => ({
        ...envelope,
        event: Deposited.parse(envelope.event),
      }));
      success(await projection.handle(replay, { ledger }));
      assert.deepEqual(success(ledger.list(accountId)), rows);

      success(await bank.flush());
      assert.equal(success(ledger.list()).length, 1);
      assert.equal(notificationSystem.attempts, 1);
    }
    // The projection remains on disk after its database connection closes.
    using reopened = openLedger(temporary.filename);
    assert.equal(success(reopened.list(accountId))[0]?.balance, 100);
  });

  test(`${mode}: failed notification responses retry the same accepted notification`, async () => {
    using ledger = openLedger();
    await using notificationSystem = await startDummyNotifications({
      failFirstAfterAccept: true,
    });
    const { bank } = createBank(
      ledger,
      createNotifications(notificationSystem.url),
    );
    success(await bank.account.open("a-1"));
    success(await bank.account.deposit("a-1", 100));
    assert.deepEqual(failure(await bank.flush()), NotificationsUnavailable());
    assert.equal(notificationSystem.attempts, 1);
    assert.equal(notificationSystem.received.size, 1);
    assert.equal(success(await bank.account.get("a-1")).balance, 100);

    success(await bank.flush());
    assert.equal(notificationSystem.attempts, 2);
    assert.equal(notificationSystem.received.size, 1);
    assert.equal(success(ledger.list()).length, 1);
  });

  test(`${mode}: the notification adapter returns tagged conflicts and respects cancellation`, async () => {
    await using notificationSystem = await startDummyNotifications();
    const { send: notify } = createNotifications(notificationSystem.url);
    const input = {
      eventId: "event-1",
      accountId: "a-1",
      amount: 100,
      balance: 100,
    };
    const first = success(await notify(input));
    assert.deepEqual(success(await notify(input)), first);
    assert.deepEqual(
      failure(await notify({ ...input, amount: 200 })),
      NotificationConflict({ eventId: input.eventId }),
    );
    const attempts = notificationSystem.attempts;
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      failure(
        await notify(
          { ...input, eventId: "cancelled" },
          { signal: controller.signal },
        ),
      )._tag,
      "Unexpected",
    );
    assert.equal(notificationSystem.attempts, attempts);
    assert.equal(notificationSystem.received.size, 1);
  });
}

test("SQLite batches roll back on constraint failures and bind account IDs as values", () => {
  using ledger = openLedger();
  const row = {
    eventId: "one",
    accountId: "a'); DROP TABLE ledger; --",
    seq: 1,
    amount: 100,
    balance: 100,
  };
  assert.equal(
    failure(ledger.record([row, { ...row, eventId: "two", amount: 0 }]))._tag,
    "Unexpected",
  );
  assert.deepEqual(success(ledger.list()), []);
  success(ledger.record([row]));
  assert.deepEqual(success(ledger.list(row.accountId)), [row]);
});
