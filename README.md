# Accord examples

[Accord](https://github.com/marcelsud/accord) is a small domain modeling library for defining business rules, recording events, and composing application behavior. See the [runtime documentation](https://github.com/marcelsud/accord/blob/main/docs/runtime.md).

## Requirements

Node.js 24 or newer.

## Quick start

```sh
git clone https://github.com/marcelsud/accord-examples.git
cd accord-examples
npm ci
npm run build
npm run bank
```

## Examples

| Example                                  | What it shows                                                              | Command                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Bank](bank/README.md)                   | Factory aggregates, value objects, views, and Effect layers                | `npm run bank` / `npm run bank:effect`                                     |
| [Notifications](notifications/README.md) | External notification adapters and a SQLite ledger                         | `npm run notifications` / `npm run notifications:effect`                   |
| [Durable bank](durable-bank/index.ts)    | SQLite restart recovery and atomic projection writes                       | `npm run durable -- <db> deposit 100` then `npm run durable -- <db> drain` |
| [CRM](crm/README.md)                     | Multiple aggregates, durable consumers, contract evolution, and migrations | `npm run crm -- <db> seed` then `npm run crm -- <db> drain`                |
| [CRM migrations](crm/migrations.ts)      | Application-owned storage and contract migration experiments               | `npm run crm:migrations -- <db>`                                           |

## Accord compatibility

These examples target `@marcelsud/accord@^0.1.0`, the version intended for publication. The package is not available from npm until Accord 0.1.0 is published; after publication, `npm ci` resolves it from the registry. The lockfile already uses the registry tarball URL; run `npm ci` after publication to refresh it with registry metadata.

## License

The examples inherit the library's current `UNLICENSED` status. No open-source license has been selected yet.
