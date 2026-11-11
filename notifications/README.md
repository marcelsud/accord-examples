# An external notification system and a SQLite ledger

This example opens an account, deposits money, records a ledger entry, and asks
an external notification system to notify the account holder. Both versions use
the same account class and external system contracts.

- [`pure.ts`](pure.ts) uses native tuples.
- [`with-effect.ts`](with-effect.ts) uses `effectify`, `Effect.gen`, and `yield*`.

The domain depends on `Notifications.send` and `LedgerStore.record`. It knows
nothing about how either system stores or delivers data. You can inject a fake
notification system directly; the tests exercise this for both versions.

## Run both versions

Use Node.js 24 or newer. From the examples repository root:

```sh
npm ci && npm run build
npm run notifications
npm run notifications:effect
```

Each prints the selected mode, a committed balance of `100`, one ledger row,
and `Notifications sent: 1`. The runner starts a dummy notification system and
closes its resources when finished. The default ledger is SQLite's in-memory
`:memory:` database.

To inspect a database file afterward, pass a new filename:

```sh
npm run notifications -- /tmp/accord-pure.sqlite
npm run notifications:effect -- /tmp/accord-effect.sqlite
```

Choose an empty ledger for each run. The runner refuses a nonempty ledger
because aggregate state and event sequence numbers start fresh in memory.

## Follow the domain

Both implementations register the `Account` class in `model()` and provide
the ledger and notification services through `wire()`. The Effect version
uses `effectify` and `Effect.gen` for its consumers.

Both policies use `on(Deposited, handler)`. The handler receives the deposited
event first, services second, and envelope metadata third. The Effect version
wraps the handler with `effectify` and obtains its services through Effect keys.
The envelope's stable event ID identifies a notification across retries.

```ts
const [, openError] = await bank.account.open("a-1");
if (openError !== null) throw openError;

const [receipt, error] = await bank.account.deposit("a-1", 100);
if (error !== null) throw error;
console.log(receipt.reply.balance); // 100

const [, deliveryError] = await bank.flush();
if (deliveryError !== null) throw deliveryError;
```

1. An account method updates state and emits `Opened` or `Deposited`. Accord
   saves the state and events together on success.
2. `bank.flush()` delivers events to the ledger projection and notification
   policy.
3. The projection calls `LedgerStore.record`. Stable event IDs allow the store to
   accept a replay without adding another entry.
4. The policy calls `Notifications.send`. The external system returns an
   acknowledgement or a domain rejection such as `NotificationsUnavailable` or
   `NotificationConflict({ eventId })`.

The consumers are independent. A committed receipt does not mean both have
completed. `flush()` reports the first failed delivery; another flush retries it.
There is no transaction across the ledger and notification system.

## Swap the external system

Pass any implementation of `NotificationPort` to `createBank`:

```ts
const notifications: NotificationPort = {
  async send(input) {
    console.log("Notification requested:", input.accountId);
    return ok({ id: `fake-${input.eventId}` });
  },
};

const { bank } = createBank(ledger, notifications);
```

This is an excerpt using `NotificationPort` from `domain.ts`, `ok` from Accord,
an opened ledger adapter, and `createBank` from either implementation.

## Adapter implementation

Only the adapters know the delivery protocol. The runnable example uses a real
HTTP connection to a dummy service on an available loopback port. No public
service or account is required.

The notification adapters URL-encode the stable event ID as an idempotency key,
validate acknowledgements, impose a five-second timeout, and forward
cancellation. They translate a conflicting request into `NotificationConflict`
and an unsuccessful service response into `NotificationsUnavailable`. Network
and decoding failures become `Unexpected`. Transport status codes stay inside
the adapters.

The dummy service can accept a notification and then fail its response. A retry
returns the original acknowledgement. Deduplication belongs to the receiving
system; an idempotency key alone cannot guarantee it.

The SQLite adapter uses prepared statements and transactions. Replaying a batch
upserts the same event IDs. A failed statement rolls back the entire batch.

## Read the files

| File                                                                   | Responsibility                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| [`domain.ts`](domain.ts)                                               | Account class, rejections, and external system contracts  |
| [`pure.ts`](pure.ts)                                                   | Native projection, policy, and model composition          |
| [`with-effect.ts`](with-effect.ts)                                     | Effect projection, policy, and model composition          |
| [`adapters/notifications.ts`](adapters/notifications.ts)               | Native notification adapter                               |
| [`adapters/notifications-effect.ts`](adapters/notifications-effect.ts) | Effect notification adapter                               |
| [`adapters/dummy-notifications.ts`](adapters/dummy-notifications.ts)   | Dummy notification system                                 |
| [`adapters/sqlite.ts`](adapters/sqlite.ts)                             | SQLite ledger implementation                              |
| [`run.ts`](run.ts)                                                     | Binds the adapters, wires the model, and runs the example |

## Verify failure and replay behavior

[`test/notifications.test.ts`](../test/notifications.test.ts) runs both domain
versions with fake notifications and real adapters. It verifies persistence
after reopening SQLite, idempotent projection writes, notification retry and
deduplication, conflicting requests, cancellation, and SQL rollback.

Enable the dummy system's failed-response mode with
`startDummyNotifications({ failFirstAfterAccept: true })`.

The default runner persists the **derived ledger only**. Its aggregate state,
event history, receipts, and delivery checkpoints remain in memory. Keeping
that runner's ledger alone does not restore an account after restart. The dummy
notification system's deduplication map also lives in memory.

For durable state and delivery, supply the SQLite runtime store. Use the same
connection for the ledger so its writes commit with the projection checkpoint:

```ts
import { sqlite } from "@marcelsud/accord/sqlite";

using storage = sqlite("bank.sqlite");
using ledger = openLedger(storage.database);
const { bank } = createBank(ledger, notifications, storage);
const [, error] = await bank.flush();
if (error !== null) throw error;
```

This excerpt uses `openLedger`, either `createBank`, and an application-supplied
notification adapter. On a shared connection, `record()` joins the runtime's
transaction and does not close the shared database when disposed. Reopen the
same file to resume pending events. Notification sends remain external effects
and require destination idempotency when a response is lost. See the
[durable counter example](../durable-bank/index.ts) for a runnable restart demonstration.
