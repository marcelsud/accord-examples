# Durable CRM and contract migrations

This example registers companies and contacts, qualifies a contact, opens a
deal, and moves it from discovery through proposal to won. Policies create
follow-up and onboarding task records. A view serves the deal card, and a
projection maintains a searchable SQLite pipeline.

## Run the v1 CRM

Use Node.js 24 or newer. From the examples repository root, install and build:

```sh
npm ci && npm run build
npm run crm -- /tmp/accord-crm.sqlite seed
npm run crm -- /tmp/accord-crm.sqlite drain
npm run crm -- /tmp/accord-crm.sqlite drain
```

Use a new filename for a fresh demonstration, or a writable local path on
Windows. `seed` commits the sales flow without flushing its consumers. The next
process restores the state and delivers pending events. The first drain creates
one won pipeline row for 2,400,000 minor BRL units and two task records. Repeated
drains leave those rows unchanged. `show` reads the existing state and tables
without draining. Repeating `seed` resumes the fixed demo flow from its stored
state.

Both adapters use `storage.database`. Each consumer's SQL changes commit with
its checkpoint. The tasks are durable pending work records; this example does
not execute them when they become due. Each aggregate command commits
separately, and cross-aggregate reference checks belong to the application flow.

## Demonstrate contract changes

After the v1 seed and drain, run:

```sh
npm run crm:migrations -- /tmp/accord-crm.sqlite
```

The script opens that database read-only and uses SQLite backups for every
experiment. It prints the temporary directory containing those copies. The
assertions expect the fixed v1 demo deal and amount above.

The v2 contract replaces `amount` and `currency` with
`money: { minor, currency }` and adds a required `channel`. Migrated records use
the explicit historical value `LEGACY`; a new v2 deal uses `INBOUND`.

Event exports use module namespaces while persisted tags remain distinct:

```ts
// v1.ts
export const DealChanged = event("DealChanged", schemaV1);

// v2.ts
export const DealChanged = event("DealChangedV2", schemaV2);
```

The same convention applies to `DealWon`. Inside the v2 module, its projection
subscribes to `[V1.DealChanged, DealChanged]`. A consumer importing both modules
can refer to `[V1.DealChanged, V2.DealChanged]`.

The script demonstrates and asserts:

| Experiment                                                  | Result                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Change the aggregate contract without migrating snapshots   | Stored state retains the old shape; explicit v2 validation fails.                              |
| Change projection code but keep its version                 | Existing checkpoints prevent replay.                                                           |
| Bump the version while assuming new payloads                | Replay fails because old events lack `details.money`.                                          |
| Change `CREATE TABLE IF NOT EXISTS`                         | Existing columns do not change.                                                                |
| Subscribe only to the new event tag                         | Legacy events are filtered out and rebuild no rows.                                            |
| Bump a counter version and reuse its destination            | Replayed increments double the total; a fresh destination rebuilds correctly.                  |
| Fail halfway through snapshot migration                     | The whole migration rolls back; retry succeeds and subsequent runs are no-ops.                 |
| Migrate snapshots and adapt historical events during replay | The old deal rebuilds into the v2 table without repeating its tasks.                           |
| Restart with mixed event history                            | Two pipeline rows and three tasks remain stable; original aggregate-event bytes are unchanged. |

## Migration boundaries

The snapshot migration is offline and application-owned. It checks Accord
storage format `1`, decodes the stored V8 records, updates deal state while
preserving versions and receipts, creates a new projection destination, and
records its migration ID in one transaction. Run such a migration while
application writers are stopped. It does not rewrite historical events or
change the Accord storage-format version.

The v2 application adapts old events when reading them, emits new event tags,
and rebuilds view/projection version `2`. Existing policies retain their names
and versions so their saved delivery progress is preserved. The old projection
table is retained for comparison. Starting the v1 application against an
upgraded file is not a rollback strategy: view versions cannot decrease and
snapshots now use the new contract. Recovery requires a compatible deployment
plan or restoring the pre-migration database.

Accord does not currently provide an automatic domain migration runner or an
upcaster registry. The functions here demonstrate explicit application code
against the current storage layout.

## Files

- [`v1.ts`](v1.ts): full CRM, SQLite adapters, and seed/drain/show CLI.
- [`v2.ts`](v2.ts): new contracts, compatible history readers, and v2 projection.
- [`migrations.ts`](migrations.ts): backup-based migration and failure experiments.
