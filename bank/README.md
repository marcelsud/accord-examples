# Bank

The Account factory receives state and `emit` once and returns the account
methods. The initial state contains a status string and a balance in cents.
The deposit method uses `Balance.of()` for arithmetic and writes the resulting
cents back to state. [Domain definition](domain.ts)

Both runners share the same balance view. Its `on(Deposited, handler)` takes
the new balance from the event, and `initial` supplies the view's state type.

`wire(Bank, { services })` supplies the deposit rules and adds the account ID to
the methods.
`bank.account.deposit("a-1", 100)` commits the updated snapshot and emitted
events together.

From the examples repository root, after `npm ci && npm run build`:

```sh
npm run bank
npm run bank:effect
```

[`pure.ts`](pure.ts) opens an account, deposits 100, and reads its balance view
at the command receipt. It prints account state as
`{ status: "OPEN", balance: 100 }`.

The runner also deposits 100 into `SavingsAccount`, which holds its balance in
`{ balance: { cents: 100 } }`. It passes that state to `SavingsAccount.create()`
and previews a second deposit locally, which returns a balance of 150.
[`with-effect.ts`](with-effect.ts) creates a named service with
`effectify(BankModel, "Bank")` and provides `DepositRules` to `Bank.layer`.
Inside `Effect.gen`, `yield* Bank` gets the wired client. Each bank call is
yielded directly. It prints `{ balance: 100 }`.

For a standalone test, supply the starting state directly to `Account.create()`.
Call the method and inspect the resulting state and events.

```ts
import { Account } from "./domain.js";

const account = Account.create(
  { status: "OPEN", balance: 100 },
  { rules: { maximum: 1_000 } },
);
const [reply, error] = account.deposit(50);
if (error !== null) throw error;

console.log(reply); // { balance: 150 }
console.log(account.getState()); // { status: "OPEN", balance: 150 }
console.log(account.pullEvents()); // [{ _tag: "Deposited", amount: 50, balance: 150 }]
```
