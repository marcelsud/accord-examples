import {
  model,
  projection,
  trycatch,
  wire,
  type Result,
  type Tagged,
} from "@marcelsud/accord";
import { sqlite } from "@marcelsud/accord/sqlite";
import { Account, Deposited } from "../notifications/domain.js";

function value<T, E extends Tagged>(result: Result<T, E>): T {
  if (result[1] !== null) throw result[1];
  return result[0] as T;
}

const filename = process.argv[2] ?? "accord.sqlite";
const action = process.argv[3] ?? "drain";
if (action !== "deposit" && action !== "drain")
  throw new Error("Choose deposit or drain");

using storage = sqlite(filename);
storage.database.exec(`
  CREATE TABLE IF NOT EXISTS deposit_totals (
    account_id TEXT PRIMARY KEY,
    total INTEGER NOT NULL
  ) STRICT
`);
const increment = storage.database.prepare(`
  INSERT INTO deposit_totals(account_id, total) VALUES (?, ?)
  ON CONFLICT(account_id) DO UPDATE SET total = total + excluded.total
`);

const Totals = projection(
  "Totals",
  { from: Account, on: [Deposited], batch: { size: 100 } },
  (batch) =>
    trycatch(() => {
      // The runtime owns this transaction and commits its checkpoint with these writes.
      for (const { source, event } of batch)
        increment.run(source.id, event.amount);
    }),
);
const Bank = model("DurableBank", {
  aggregates: { account: Account },
  projections: [Totals],
});
const bank = wire(Bank, { storage });

if (action === "deposit") {
  if (!value(await bank.account.get("a-1")).open)
    value(await bank.account.open("a-1"));
  const receipt = value(
    await bank.account.deposit("a-1", Number(process.argv[4] ?? 100)),
  );
  console.log("Committed balance:", receipt.reply.balance);
  console.log(
    "Events saved. Exit before flush; run again with drain to recover them.",
  );
} else {
  value(await bank.flush());
  console.log("Restored account:", value(await bank.account.get("a-1")));
  console.table(
    storage.database
      .prepare(
        "SELECT account_id, total FROM deposit_totals ORDER BY account_id",
      )
      .all(),
  );
}
