import {
  aggregate,
  fail,
  ok,
  event,
  integer,
  refine,
  rejection,
  service,
  string,
  type Envelope,
  type ExecutionContext,
  type Infer,
  type InvalidInput,
  type Result,
  type Unexpected,
} from "@marcelsud/accord";

export const Cents = refine(integer, (value) => value > 0, "positive cents");
export const Opened = event("Opened");
export const Deposited = event("Deposited", {
  amount: Cents,
  balance: integer,
});
export const AlreadyOpen = rejection("AlreadyOpen");
export const NotOpen = rejection("NotOpen");
export const NotificationsUnavailable = rejection("NotificationsUnavailable");
export const NotificationConflict = rejection("NotificationConflict", {
  eventId: string,
});

export class Account extends aggregate("Account", { open: false, balance: 0 }) {
  open() {
    if (this.state.open) return fail(AlreadyOpen());

    this.state.open = true;
    this.emit(Opened());
    return ok(undefined);
  }

  deposit(amount: number) {
    if (!this.state.open) return fail(NotOpen());

    const event = Deposited({ amount, balance: this.state.balance + amount });
    this.state.balance = event.balance;
    this.emit(event);
    return ok({ balance: event.balance });
  }
}

export const Notification = {
  eventId: string,
  accountId: string,
  amount: Cents,
  balance: integer,
};
export const Acknowledgement = { id: string };
export const SendNotificationContract = {
  input: Notification,
  reply: Acknowledgement,
  rejects: [NotificationsUnavailable, NotificationConflict],
};
export interface NotificationPort {
  send(
    input: Infer<typeof Notification>,
    options?: ExecutionContext,
  ): Promise<
    Result<
      Infer<typeof Acknowledgement>,
      | ReturnType<typeof NotificationsUnavailable>
      | ReturnType<typeof NotificationConflict>
      | InvalidInput
      | Unexpected
    >
  >;
}
export const Notifications = service("Bank/Notifications", {
  parse(value: unknown): NotificationPort {
    if (
      !value ||
      typeof value !== "object" ||
      !("send" in value) ||
      typeof value.send !== "function"
    ) {
      throw new TypeError("Expected a notification system with send(input)");
    }
    return value as NotificationPort;
  },
});

export const LedgerRow = {
  eventId: string,
  accountId: string,
  seq: integer,
  amount: Cents,
  balance: integer,
};
export type LedgerRow = Infer<typeof LedgerRow>;
export interface LedgerPort {
  record(rows: readonly LedgerRow[]): Result<void, Unexpected>;
}
export const LedgerStore = service("Bank/LedgerStore", {
  parse(value: unknown): LedgerPort {
    if (
      !value ||
      typeof value !== "object" ||
      !("record" in value) ||
      typeof value.record !== "function"
    ) {
      throw new TypeError("Expected a ledger with record(rows)");
    }
    return value as LedgerPort;
  },
});
export function ledgerRows(
  batch: readonly Envelope<ReturnType<typeof Deposited>>[],
): LedgerRow[] {
  return batch.map(({ id, source, seq, event }) => ({
    eventId: id,
    accountId: source.id,
    seq,
    amount: event.amount,
    balance: event.balance,
  }));
}
