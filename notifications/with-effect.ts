import { Effect } from "effect";
import { effectify } from "@marcelsud/accord/effect";
import {
  wire,
  memory,
  model,
  on,
  policy,
  projection,
  type RuntimeStore,
} from "@marcelsud/accord";
import {
  Account,
  Deposited,
  LedgerStore,
  Notifications,
  ledgerRows,
  type LedgerPort,
  type NotificationPort,
} from "./domain.js";

const LedgerProjection = projection(
  "Ledger",
  {
    from: Account,
    on: [Deposited],
    uses: { ledger: LedgerStore },
    batch: { size: 100 },
  },
  effectify((batch) =>
    Effect.gen(function* () {
      const ledger = yield* effectify(LedgerStore);
      const [, error] = ledger.record(ledgerRows(batch));
      if (error !== null) return yield* Effect.fail(error);
      return undefined;
    }),
  ),
);
const NotifyDeposit = policy(
  "NotifyDeposit",
  { from: Account, uses: { notifications: Notifications } },
  on(
    Deposited,
    effectify((event, _services, { id, source }) =>
      Effect.gen(function* () {
        const notifications = yield* effectify(Notifications);
        const [, error] = yield* Effect.promise((signal) =>
          notifications.send(
            {
              eventId: id,
              accountId: source.id,
              amount: event.amount,
              balance: event.balance,
            },
            { signal },
          ),
        );
        if (error !== null) return yield* Effect.fail(error);
        return undefined;
      }),
    ),
  ),
);
const Bank = model("Bank", {
  aggregates: { account: Account },
  projections: [LedgerProjection],
  policies: [NotifyDeposit],
});
export function createBank(
  ledger: LedgerPort,
  notifications: NotificationPort,
  storage: RuntimeStore = memory(),
) {
  const bank = wire(Bank, { storage, services: { ledger, notifications } });
  return { bank, projection: LedgerProjection };
}
