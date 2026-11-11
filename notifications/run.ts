import { startDummyNotifications } from "./adapters/dummy-notifications.js";
import { openLedger } from "./adapters/sqlite.js";

const mode = process.argv[2] ?? "pure";
if (mode !== "pure" && mode !== "effect")
  throw new Error("Choose pure or effect");
const filename = process.argv[3] ?? ":memory:";
const { createBank } = await import(
  mode === "pure" ? "./pure.js" : "./with-effect.js"
);

const { createNotifications } = await import(
  mode === "pure"
    ? "./adapters/notifications.js"
    : "./adapters/notifications-effect.js"
);
await using notificationSystem = await startDummyNotifications();
using ledger = openLedger(filename);
const [existing, readError] = ledger.list();
if (readError !== null) throw readError;
if (existing.length)
  throw new Error(
    "Choose an empty ledger: this demo starts with fresh in-memory aggregate state",
  );
const { bank } = createBank(
  ledger,
  createNotifications(notificationSystem.url),
);

const accountId = "a-1";
const [, openError] = await bank.account.open(accountId);
if (openError !== null) throw openError;
const [receipt, error] = await bank.account.deposit(accountId, 100);
if (error !== null) throw error;

console.log(`Mode: ${mode}`);
console.log(`SQLite: ${filename}`);
console.log(`Committed balance: ${receipt.reply.balance}`);

const [, deliveryError] = await bank.flush();
if (deliveryError !== null) throw deliveryError;
const [rows, queryError] = ledger.list(accountId);
if (queryError !== null) throw queryError;

console.table(rows);
console.log(`Notifications sent: ${notificationSystem.received.size}`);
