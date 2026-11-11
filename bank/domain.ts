import {
  aggregate,
  event,
  fail,
  integer,
  literal,
  model,
  ok,
  on,
  parse,
  refine,
  rejection,
  service,
  union,
  view,
  vo,
  type Infer,
} from "@marcelsud/accord";

const StatusSchema = union(
  literal("PENDING"),
  literal("OPEN"),
  literal("CLOSED"),
);

type Status = Infer<typeof StatusSchema>;

const Status = {
  of(value: Status): Status {
    return parse(StatusSchema, value);
  },
};

const Cents = refine(integer, (amount) => amount > 0, "positive cents");

export const DepositRules = service("DepositRules", { maximum: Cents });

class Balance extends vo("Balance", integer) {
  get cents() {
    return this.value;
  }

  inc(amount: number): Balance {
    return Balance.of(this.cents + parse(Cents, amount));
  }
}

const Opened = event("Opened");
const Deposited = event("Deposited", { amount: Cents, balance: integer });
const CannotOpen = rejection("CannotOpen", { status: StatusSchema });
const NotOpen = rejection("NotOpen");
const DepositLimit = rejection("DepositLimit", { maximum: Cents });

export const Account = aggregate(
  "Account",
  { status: Status.of("PENDING"), balance: 0 },
  ({ state, emit, rules }) => ({
    open() {
      if (state.status !== "PENDING") {
        return fail(CannotOpen({ status: state.status }));
      }

      state.status = Status.of("OPEN");
      emit(Opened());
      return ok(undefined);
    },

    deposit(amount: number) {
      if (state.status !== "OPEN") return fail(NotOpen());
      if (amount > rules.maximum) {
        return fail(DepositLimit({ maximum: rules.maximum }));
      }

      const balance = Balance.of(state.balance).inc(amount).cents;
      state.balance = balance;

      emit(Deposited({ amount, balance }));
      return ok({ balance });
    },
  }),
  { uses: { rules: DepositRules } },
);

export const SavingsAccount = aggregate(
  "SavingsAccount",
  { balance: { cents: 0 } },
  ({ state }) => ({
    deposit(amount: number) {
      const balance = Balance.of(state.balance.cents).inc(amount).cents;
      state.balance.cents = balance;
      return ok({ balance });
    },
  }),
);

const Summary = view(
  "Summary",
  { from: Account, initial: { balance: 0 } },
  on(Deposited, (_state, { balance }) => ({ balance })),
);

export const Bank = model("Bank", {
  aggregates: { account: Account, savings: SavingsAccount },
  views: { summary: Summary },
});
