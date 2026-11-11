import { DatabaseSync } from "node:sqlite";
import { fail, parse, trycatch, unexpected } from "@marcelsud/accord";
import { LedgerRow } from "../domain.js";

/** Own a ledger connection, or join the durable runtime's transaction on a shared connection. */
export function openLedger(filename: string | DatabaseSync = ":memory:") {
  const ownsConnection = typeof filename === "string";
  const database = ownsConnection ? new DatabaseSync(filename) : filename;
  const [, setupError] = trycatch(() =>
    database.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      event_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      amount INTEGER NOT NULL CHECK (amount > 0),
      balance INTEGER NOT NULL CHECK (balance >= 0)
    ) STRICT
  `),
  );
  if (setupError !== null) {
    if (ownsConnection) database.close();
    throw setupError;
  }
  const upsert = database.prepare(`
    INSERT INTO ledger (event_id, account_id, seq, amount, balance) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (event_id) DO UPDATE SET
      account_id = excluded.account_id, seq = excluded.seq,
      amount = excluded.amount, balance = excluded.balance
  `);
  const select =
    "SELECT event_id AS eventId, account_id AS accountId, seq, amount, balance FROM ledger";
  const allRows = database.prepare(`${select} ORDER BY account_id, seq`);
  const accountRows = database.prepare(
    `${select} WHERE account_id = ? ORDER BY seq`,
  );

  return {
    record(rows: readonly LedgerRow[]) {
      const ownsTransaction = !database.isTransaction;
      if (ownsTransaction) {
        const [, beginError] = trycatch(() => database.exec("BEGIN IMMEDIATE"));
        if (beginError !== null) return fail(beginError);
      }
      const result = trycatch(() => {
        for (const row of rows)
          upsert.run(
            row.eventId,
            row.accountId,
            row.seq,
            row.amount,
            row.balance,
          );
        if (ownsTransaction) database.exec("COMMIT");
      });
      if (result[1] !== null && ownsTransaction) {
        const [, rollbackError] = trycatch(() => database.exec("ROLLBACK"));
        if (rollbackError !== null)
          return fail(
            unexpected({ write: result[1], rollback: rollbackError }),
          );
      }
      return result;
    },
    list(accountId?: string) {
      return trycatch(() =>
        (accountId === undefined
          ? allRows.all()
          : accountRows.all(accountId)
        ).map((row) => parse(LedgerRow, row)),
      );
    },
    [Symbol.dispose]() {
      if (ownsConnection) database.close();
    },
  };
}
