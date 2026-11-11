import { wire } from "@marcelsud/accord";
import { Bank, SavingsAccount } from "./domain.js";

const bank = wire(Bank, { services: { rules: { maximum: 1_000 } } });
const id = "a-1";
const [, openError] = await bank.account.open(id);
if (openError !== null) throw openError;
const [receipt, error] = await bank.account.deposit(id, 100);
if (error !== null) throw error;
const [summary, readError] = await bank.summary.get(id, {
  atLeast: receipt,
});
if (readError !== null) throw readError;
console.log("Balance view:", summary); // { balance: 100 }

const [state, stateError] = await bank.account.get(id);
if (stateError !== null) throw stateError;

console.log("Account snapshot:", state); // { status: "OPEN", balance: 100 }

const [, savingsError] = await bank.savings.deposit(id, 100);
if (savingsError !== null) throw savingsError;

const [snapshot, snapshotError] = await bank.savings.get(id);
if (snapshotError !== null) throw snapshotError;
console.log("Savings snapshot:", snapshot); // { balance: { cents: 100 } }

const preview = SavingsAccount.create(snapshot);
const [reply, previewError] = preview.deposit(50);
if (previewError !== null) throw previewError;
console.log("Standalone savings preview:", reply); // { balance: 150 }
