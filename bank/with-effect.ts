import { Effect, Layer } from "effect";
import { effectify } from "@marcelsud/accord/effect";
import { Bank as BankModel, DepositRules } from "./domain.js";

const Bank = effectify(BankModel, "Bank");
const RulesLive = Layer.succeed(effectify(DepositRules), { maximum: 1_000 });

const BankLive = Bank.layer.pipe(Layer.provide(RulesLive));

const program = Effect.gen(function* () {
  const bank = yield* Bank;
  const id = "a-1";

  yield* bank.account.open(id);
  const receipt = yield* bank.account.deposit(id, 100);
  return yield* bank.summary.get(id, { atLeast: receipt });
});

const summary = await Effect.runPromise(Effect.provide(program, BankLive));
console.log(summary); // { balance: 100 }
