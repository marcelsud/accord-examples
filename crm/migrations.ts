// Run after compilation: node migrations.js path/to/the/v1/crm.sqlite
// All experiments use SQLite backups. The supplied v1 database is opened read-only.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import {
  event,
  model,
  ok,
  parse,
  projection,
  string,
  trycatch,
  wire,
} from "@marcelsud/accord";
import { sqlite } from "@marcelsud/accord/sqlite";
import * as V1 from "./v1.js";
import * as V2 from "./v2.js";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Supply the v1 CRM SQLite filename");
const directory = mkdtempSync(join(tmpdir(), "accord-crm-migrations-"));
const source = new DatabaseSync(sourcePath, { readOnly: true });
const originals = source
  .prepare(
    "SELECT id, envelope FROM accord_events WHERE kind = 'aggregate' ORDER BY id",
  )
  .all();
const baselineTasks = source
  .prepare("SELECT COUNT(*) AS count FROM crm_tasks")
  .get()!.count;
const baselinePipeline = source
  .prepare("SELECT * FROM crm_pipeline WHERE deal_id = 'deal-1'")
  .get();
assert.equal(
  baselinePipeline?.stage,
  "WON",
  "First run the v1 CRM seed and drain commands",
);
assert.equal(baselinePipeline?.amount, 2_400_000);

async function copy(label: string) {
  const filename = join(directory, `${label}.sqlite`);
  await backup(source, filename);
  return filename;
}
function dealRecord(db: DatabaseSync) {
  const row = db
    .prepare(
      "SELECT value FROM accord_records WHERE namespace = 'aggregates' AND key = ?",
    )
    .get(JSON.stringify(["CRM", "Deal", "deal-1"]))!;
  return deserialize(row.value as Uint8Array);
}
function assertHistoryPreserved(db: DatabaseSync) {
  for (const old of originals) {
    const current = db
      .prepare(
        "SELECT envelope FROM accord_events WHERE kind = 'aggregate' AND id = ?",
      )
      .get(old.id!);
    assert.deepEqual(
      current?.envelope,
      old.envelope,
      `Historical event changed: ${old.id}`,
    );
  }
}
const observations: Array<{ experiment: string; observed: string }> = [];

// 1. Stored snapshots are not automatically merged with a new contract.
{
  const filename = await copy("snapshot-without-migration");
  using storage = sqlite(filename);
  const crm = wire(model("CRM", { aggregates: { deal: V2.Deal } }), {
    storage,
  });
  const state = V1.value(await crm.deal.get("deal-1"));
  assert.ok(state.details);
  assert.equal(state.details.money, undefined);
  assert.throws(() => parse(V2.DealDetails, state.details));
  observations.push({
    experiment: "New state contract, old snapshot",
    observed: "Read returns the old shape; explicit v2 validation fails",
  });
}

// 2. Same consumer identity means the existing checkpoint remains authoritative.
// Changing the schema under the old event tag does not transform stored envelopes.
{
  const filename = await copy("incompatible-event-contract");
  using storage = sqlite(filename);
  const ChangedInPlace = event("DealChanged", {
    details: V2.DealDetails,
    stage: V1.Stage,
    lossReason: string,
  });
  let calls = 0;
  function broken(version: number) {
    const pipeline = projection(
      "SearchablePipeline",
      { from: V2.Deal, on: [ChangedInPlace], version },
      (batch) => {
        calls++;
        return trycatch(() => {
          for (const { event } of batch) void event.details.money.minor;
        });
      },
    );
    return wire(
      model("CRM", { aggregates: { deal: V2.Deal }, projections: [pipeline] }),
      { storage },
    );
  }
  V1.value(await broken(1).flush());
  assert.equal(calls, 0);
  observations.push({
    experiment: "Changed projection code, same version",
    observed:
      "0 handler calls; previously acknowledged events are not replayed",
  });
  const failed = await broken(2).flush();
  assert.equal(failed[1]?._tag, "Unexpected");
  assert.equal(calls, 1);
  const cause = failed[1] instanceof Error ? failed[1].cause : undefined;
  console.log(
    "Incompatible replay error:",
    cause instanceof Error ? cause.message : failed[1],
  );
  assert.equal(
    storage.database
      .prepare("SELECT amount FROM crm_pipeline WHERE deal_id = 'deal-1'")
      .get()!.amount,
    2_400_000,
  );
  observations.push({
    experiment: "Bump version, assume new payload",
    observed: "Replay fails: historical payload has no details.money",
  });

  // CREATE TABLE IF NOT EXISTS is not a column migration.
  storage.database.exec(
    "CREATE TABLE IF NOT EXISTS crm_pipeline(deal_id TEXT PRIMARY KEY, amount_minor INTEGER NOT NULL) STRICT",
  );
  assert.throws(
    () => storage.database.prepare("SELECT amount_minor FROM crm_pipeline"),
    /no such column/,
  );
  observations.push({
    experiment: "Change CREATE TABLE IF NOT EXISTS",
    observed: "Old table still has amount; selecting amount_minor fails",
  });
  assertHistoryPreserved(storage.database);
}

// 3. A new tag alone cannot rebuild rows from old event tags.
{
  const filename = await copy("new-tag-without-legacy-reader");
  using storage = sqlite(filename);
  storage.database.exec(V2.pipelineDDL);
  let calls = 0;
  const pipeline = projection(
    "SearchablePipeline",
    { from: V2.Deal, on: [V2.DealChanged], version: 2 },
    () => {
      calls++;
      return ok(undefined);
    },
  );
  const crm = wire(
    model("CRM", { aggregates: { deal: V2.Deal }, projections: [pipeline] }),
    { storage },
  );
  V1.value(await crm.flush());
  assert.equal(calls, 0);
  assert.equal(
    storage.database
      .prepare("SELECT COUNT(*) AS count FROM crm_pipeline_v2")
      .get()!.count,
    0,
  );
  observations.push({
    experiment: "Subscribe only to DealChangedV2",
    observed: "0 rows rebuilt: legacy DealChanged events are filtered out",
  });
}

// A new consumer version replays history. Reusing an additive destination counts twice.
{
  const filename = await copy("counter-rebuild");
  using storage = sqlite(filename);
  const db = storage.database;
  db.exec(`
    CREATE TABLE crm_won_totals(owner_id TEXT PRIMARY KEY, total_minor INTEGER NOT NULL) STRICT;
    CREATE TABLE crm_won_totals_v2(owner_id TEXT PRIMARY KEY, total_minor INTEGER NOT NULL) STRICT;
  `);
  function counter(
    version: number,
    destination: "crm_won_totals" | "crm_won_totals_v2",
  ) {
    const increment =
      db.prepare(`INSERT INTO ${destination}(owner_id, total_minor) VALUES (?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET total_minor = total_minor + excluded.total_minor`);
    const totals = projection(
      "WonTotals",
      { from: V2.Deal, on: [V1.DealWon], version },
      (batch) =>
        trycatch(() => {
          for (const { event } of batch)
            increment.run(event.details.ownerId, event.details.amount);
        }),
    );
    return wire(
      model("CRM", { aggregates: { deal: V2.Deal }, projections: [totals] }),
      { storage },
    );
  }
  V1.value(await counter(1, "crm_won_totals").flush());
  assert.equal(
    db.prepare("SELECT total_minor FROM crm_won_totals").get()!.total_minor,
    2_400_000,
  );
  V1.value(await counter(2, "crm_won_totals").flush());
  assert.equal(
    db.prepare("SELECT total_minor FROM crm_won_totals").get()!.total_minor,
    4_800_000,
  );
  V1.value(await counter(3, "crm_won_totals_v2").flush());
  assert.equal(
    db.prepare("SELECT total_minor FROM crm_won_totals_v2").get()!.total_minor,
    2_400_000,
  );
  observations.push({
    experiment: "Bump counter version, reuse destination",
    observed:
      "Total doubles from 2400000 to 4800000; a fresh destination rebuilds to 2400000",
  });
}

/** Offline, application-owned migration for Accord storage format 1. */
function migrate(filename: string, injectFailure = false) {
  using storage = sqlite(filename);
  const db = storage.database;
  assert.equal(
    db.prepare("SELECT version FROM accord_schema").get()!.version,
    1,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS crm_app_migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    const id = "002-deal-money-and-channel";
    if (db.prepare("SELECT 1 FROM crm_app_migrations WHERE id = ?").get(id)) {
      db.exec("COMMIT");
      return 0;
    }
    let migrated = 0;
    const update = db.prepare(
      "UPDATE accord_records SET value = ? WHERE namespace = 'aggregates' AND key = ?",
    );
    for (const row of db
      .prepare(
        "SELECT key, value FROM accord_records WHERE namespace = 'aggregates'",
      )
      .all()) {
      const parts = JSON.parse(row.key as string);
      if (parts[0] !== "CRM" || parts[1] !== "Deal") continue;
      const record = deserialize(row.value as Uint8Array);
      if (record.state.details !== null) {
        // Preserve state version and receipts. This migration emits no domain events.
        record.state = {
          ...record.state,
          details: V2.upgradeDetails(record.state.details),
        };
        update.run(serialize(record), row.key!);
        migrated++;
      }
    }
    if (injectFailure) throw new Error("Simulated migration failure");
    // Build a new destination; do not overwrite the v1 projection table.
    db.exec(V2.pipelineDDL);
    db.prepare(
      "INSERT INTO crm_app_migrations(id, applied_at) VALUES (?, ?)",
    ).run(id, Date.now());
    db.exec("COMMIT");
    return migrated;
  } catch (cause) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw cause;
  }
}

// 4. A failed migration leaves both domain data and the migration ledger unchanged.
{
  const filename = await copy("migration-rollback");
  assert.throws(() => migrate(filename, true), /Simulated migration failure/);
  {
    using storage = sqlite(filename);
    assert.equal(dealRecord(storage.database).state.details.amount, 2_400_000);
    assert.equal(dealRecord(storage.database).state.details.money, undefined);
    assert.equal(
      storage.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'crm_app_migrations'",
        )
        .get(),
      undefined,
    );
    assertHistoryPreserved(storage.database);
  }
  assert.equal(migrate(filename), 1);
  assert.equal(migrate(filename), 0);
  observations.push({
    experiment: "Migration interrupted; retry",
    observed: "Whole migration rolls back; retry succeeds; next run is a no-op",
  });
}

// 5. Safe upgrade: snapshots + new SQL destination + compatible history reader.
const upgraded = await copy("safe-v2-upgrade");
assert.equal(migrate(upgraded), 1);
assert.equal(migrate(upgraded), 0);
{
  using storage = sqlite(upgraded);
  const crm = V2.createCRM(storage);
  const state = V1.value(await crm.deal.get("deal-1"));
  assert.equal(state.details!.money.minor, 2_400_000);
  assert.equal(state.details!.channel, "LEGACY");
  V1.value(await crm.flush());
  assert.equal(
    storage.database.prepare("SELECT COUNT(*) AS count FROM crm_tasks").get()!
      .count,
    baselineTasks,
  );
  const rebuilt = storage.database
    .prepare("SELECT * FROM crm_pipeline_v2 WHERE deal_id = 'deal-1'")
    .get()!;
  assert.equal(rebuilt.amount_minor, 2_400_000);
  assert.equal(rebuilt.channel, "LEGACY");
  assert.equal(rebuilt.stage, "WON");
  assertHistoryPreserved(storage.database);
  observations.push({
    experiment: "Migrate snapshots + upcast on replay",
    observed:
      "Legacy deal rebuilt as money + LEGACY; existing tasks are not repeated",
  });

  // New traffic emits new tags, while the same projection continues to read both.
  V1.value(
    await crm.deal.open("deal-2", {
      title: "Acme expansion",
      companyId: "company-1",
      contactId: "contact-1",
      ownerId: "rep-7",
      money: { minor: 420_000, currency: "BRL" },
      channel: "INBOUND",
      expectedClose: "2026-12-20",
    }),
  );
  V1.value(await crm.deal.move("deal-2", "PROPOSAL"));
  V1.value(await crm.deal.move("deal-2", "WON"));
  V1.value(await crm.flush());
  assert.equal(
    storage.database.prepare("SELECT COUNT(*) AS count FROM crm_tasks").get()!
      .count,
    Number(baselineTasks) + 1,
  );
  assertHistoryPreserved(storage.database);
  console.table(
    storage.database
      .prepare(
        "SELECT deal_id, amount_minor, currency, channel, stage FROM crm_pipeline_v2 ORDER BY deal_id",
      )
      .all(),
  );
  console.table(
    storage.database
      .prepare(
        "SELECT kind, target_id, subject FROM crm_tasks ORDER BY kind, target_id",
      )
      .all(),
  );
  const tags = storage.database
    .prepare("SELECT envelope FROM accord_events WHERE kind = 'aggregate'")
    .all()
    .map((row) => deserialize(row.envelope as Uint8Array).event._tag);
  assert.ok(tags.includes("DealChanged") && tags.includes("DealChangedV2"));
  assert.ok(tags.includes("DealWon") && tags.includes("DealWonV2"));
  // Rolling code back also needs a data/view compatibility plan.
  assert.throws(() => V1.createCRM(storage), /View versions cannot decrease/);
}
{
  using storage = sqlite(upgraded);
  const crm = V2.createCRM(storage);
  V1.value(await crm.flush());
  assert.equal(
    storage.database
      .prepare("SELECT COUNT(*) AS count FROM crm_pipeline_v2")
      .get()!.count,
    2,
  );
  assert.equal(
    storage.database.prepare("SELECT COUNT(*) AS count FROM crm_tasks").get()!
      .count,
    Number(baselineTasks) + 1,
  );
  assertHistoryPreserved(storage.database);
  observations.push({
    experiment: "Restart v2 with mixed history",
    observed:
      "2 pipeline rows and 3 tasks remain unchanged; old event bytes are intact",
  });
}

source.close();
console.table(observations);
console.log("Demonstration databases:", directory);
console.log("Original v1 database was opened read-only and left unchanged.");
