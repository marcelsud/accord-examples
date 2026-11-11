import {
  aggregate,
  event,
  fail,
  literal,
  model,
  nullable,
  ok,
  on,
  parse,
  policy,
  projection,
  string,
  trycatch,
  union,
  view,
  wire,
  type Infer,
} from "@marcelsud/accord";
import type { SQLiteStore } from "@marcelsud/accord/sqlite";
import * as V1 from "./v1.js";

export const Channel = union(
  literal("LEGACY"),
  literal("INBOUND"),
  literal("OUTBOUND"),
);
const {
  amount: _amount,
  currency: _currency,
  ...CommonDetails
} = V1.DealDetails;
export const DealDetails = {
  ...CommonDetails,
  money: { minor: V1.PositiveInteger, currency: V1.Currency },
  channel: Channel,
};

export const DealChanged = event("DealChangedV2", {
  details: DealDetails,
  stage: V1.Stage,
  lossReason: string,
});
export const DealWon = event("DealWonV2", { details: DealDetails });

/** An application-level adapter. It never edits the original event or envelope. */
export function upgradeDetails(
  value: Infer<typeof V1.DealDetails>,
): Infer<typeof DealDetails> {
  const { amount, currency, ...details } = parse(V1.DealDetails, value);
  return parse(DealDetails, {
    ...details,
    money: { minor: amount, currency },
    channel: "LEGACY",
  });
}
type Changed =
  ReturnType<typeof V1.DealChanged> | ReturnType<typeof DealChanged>;
export function readChanged(event: Changed) {
  if (event._tag === "DealChanged") {
    return DealChanged({
      details: upgradeDetails(event.details),
      stage: event.stage,
      lossReason: event.lossReason,
    });
  }
  return DealChanged.parse(event);
}

const transitions: Record<
  Infer<typeof V1.Stage>,
  readonly Infer<typeof V1.Stage>[]
> = {
  DISCOVERY: ["PROPOSAL", "LOST"],
  PROPOSAL: ["WON", "LOST"],
  WON: [],
  LOST: [],
};
export const Deal = aggregate(
  "Deal",
  {
    details: parse(nullable(DealDetails), null),
    stage: parse(V1.Stage, "DISCOVERY"),
    lossReason: "",
  },
  ({ state, emit }) => ({
    open(input: Infer<typeof DealDetails>) {
      if (state.details !== null) return fail(V1.AlreadyRegistered());
      state.details = parse(DealDetails, input);
      emit(
        DealChanged({
          details: state.details,
          stage: state.stage,
          lossReason: "",
        }),
      );
      return ok(undefined);
    },
    move(next: Infer<typeof V1.Stage>, reason = "") {
      if (state.details === null) return fail(V1.MissingRecord());
      const details = parse(DealDetails, state.details);
      const stage = parse(V1.Stage, next);
      if (!transitions[state.stage].includes(stage))
        return fail(V1.InvalidTransition({ from: state.stage, to: stage }));
      if (stage === "LOST" && !reason.trim())
        return fail(V1.LossReasonRequired());
      state.stage = stage;
      state.lossReason = stage === "LOST" ? reason.trim() : "";
      emit(DealChanged({ details, stage, lossReason: state.lossReason }));
      if (stage === "WON") emit(DealWon({ details }));
      return ok({ stage });
    },
  }),
);

export const DealCard = view(
  "DealCard",
  {
    from: Deal,
    version: 2,
    initial: {
      details: parse(nullable(DealDetails), null),
      stage: parse(V1.Stage, "DISCOVERY"),
      lossReason: "",
    },
  },
  on(V1.DealChanged, (_state, event) => {
    const { details, stage, lossReason } = readChanged(event);
    return { details, stage, lossReason };
  }),
  on(DealChanged, (_state, { details, stage, lossReason }) => ({
    details,
    stage,
    lossReason,
  })),
);

// Same policy name and version: retain its existing checkpoint, while accepting both event versions.
const HandoffWonDeal = policy(
  "HandoffWonDeal",
  { from: Deal, uses: { tasks: V1.Tasks } },
  on(V1.DealWon, (event, { tasks }, { id, source, at }) =>
    tasks.schedule({
      kind: "ONBOARDING",
      eventId: id,
      ownerId: event.details.ownerId,
      subject: `Start onboarding for ${event.details.title}`,
      targetType: "deal",
      targetId: source.id,
      dueAt: at,
    }),
  ),
  on(DealWon, (event, { tasks }, { id, source, at }) =>
    tasks.schedule({
      kind: "ONBOARDING",
      eventId: id,
      ownerId: event.details.ownerId,
      subject: `Start onboarding for ${event.details.title}`,
      targetType: "deal",
      targetId: source.id,
      dueAt: at,
    }),
  ),
);

export const pipelineDDL = `
  CREATE TABLE IF NOT EXISTS crm_pipeline_v2 (
    deal_id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL,
    title TEXT NOT NULL, owner_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    currency TEXT NOT NULL, channel TEXT NOT NULL, stage TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS crm_pipeline_v2_owner_stage ON crm_pipeline_v2(owner_id, stage);
`;

export function createCRM(storage: SQLiteStore) {
  const db = storage.database;
  const upsert = db.prepare(`
    INSERT INTO crm_pipeline_v2(deal_id, event_seq, title, owner_id, amount_minor, currency, channel, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deal_id) DO UPDATE SET
      event_seq = excluded.event_seq, title = excluded.title, owner_id = excluded.owner_id,
      amount_minor = excluded.amount_minor, currency = excluded.currency,
      channel = excluded.channel, stage = excluded.stage
    WHERE excluded.event_seq > crm_pipeline_v2.event_seq
  `);
  const pipeline = projection(
    "SearchablePipeline",
    { from: Deal, on: [V1.DealChanged, DealChanged], version: 2 },
    (batch) =>
      trycatch(() => {
        for (const { source, seq, event } of batch) {
          const { details, stage } = readChanged(event);
          upsert.run(
            source.id,
            seq,
            details.title,
            details.ownerId,
            details.money.minor,
            details.money.currency,
            details.channel,
            stage,
          );
        }
      }),
  );
  const insertTask = db.prepare(`
    INSERT INTO crm_tasks(kind, event_id, owner_id, subject, target_type, target_id, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, event_id) DO NOTHING
  `);
  const tasks = {
    schedule(task: V1.Task) {
      return trycatch(() => {
        insertTask.run(
          task.kind,
          task.eventId,
          task.ownerId,
          task.subject,
          task.targetType,
          task.targetId,
          task.dueAt,
        );
      });
    },
  };
  return wire(
    model("CRM", {
      aggregates: { company: V1.Company, contact: V1.Contact, deal: Deal },
      views: { dealCard: DealCard },
      policies: [V1.FollowUpQualifiedContact, HandoffWonDeal],
      projections: [pipeline],
    }),
    { storage, services: { tasks } },
  );
}
