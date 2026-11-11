// Node.js 24+, ESM TypeScript, and the current Accord build.
// After compilation: node v1.js crm.sqlite seed; node v1.js crm.sqlite drain
import { pathToFileURL } from "node:url";
import {
  aggregate,
  boolean,
  event,
  fail,
  integer,
  literal,
  model,
  nullable,
  ok,
  on,
  parse,
  policy,
  projection,
  refine,
  rejection,
  service,
  string,
  trycatch,
  union,
  view,
  wire,
  type Infer,
  type Result,
  type Tagged,
  type Unexpected,
} from "@marcelsud/accord";
import { sqlite, type SQLiteStore } from "@marcelsud/accord/sqlite";

const Text = refine(
  string,
  (value) => value.trim().length > 0,
  "nonempty text",
);
const PositiveInteger = refine(
  integer,
  (value) => value > 0,
  "positive integer",
);
const Email = refine(
  Text,
  (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  "email address",
);
const Website = refine(
  Text,
  (value) =>
    URL.canParse(value) &&
    ["http:", "https:"].includes(new URL(value).protocol),
  "HTTP(S) website",
);
const DateOnly = refine(
  Text,
  (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value,
  "YYYY-MM-DD date",
);
const Currency = union(literal("USD"), literal("EUR"), literal("BRL"));
const Stage = union(
  literal("DISCOVERY"),
  literal("PROPOSAL"),
  literal("WON"),
  literal("LOST"),
);
type Stage = Infer<typeof Stage>;

const CompanyDetails = {
  name: Text,
  website: Website,
  industry: Text,
  country: Text,
  employeeCount: PositiveInteger,
};
const ContactDetails = {
  firstName: Text,
  lastName: Text,
  email: Email,
  phone: string,
  title: Text,
  companyId: Text,
  ownerId: Text,
  marketingConsent: boolean,
};
const DealDetails = {
  title: Text,
  companyId: Text,
  contactId: Text,
  ownerId: Text,
  amount: PositiveInteger,
  currency: Currency,
  expectedClose: DateOnly,
};

const MissingRecord = rejection("MissingRecord");
const AlreadyRegistered = rejection("AlreadyRegistered");
const AlreadyQualified = rejection("AlreadyQualified");
const ContactNotQualified = rejection("ContactNotQualified");
const LossReasonRequired = rejection("LossReasonRequired");
const InvalidTransition = rejection("InvalidTransition", {
  from: Stage,
  to: Stage,
});

const CompanyRegistered = event("CompanyRegistered", {
  details: CompanyDetails,
});
const ContactRegistered = event("ContactRegistered", {
  details: ContactDetails,
});
const ContactQualified = event("ContactQualified", { details: ContactDetails });
const DealChanged = event("DealChanged", {
  details: DealDetails,
  stage: Stage,
  lossReason: string,
});
const DealWon = event("DealWon", { details: DealDetails });

const Company = aggregate(
  "Company",
  { details: parse(nullable(CompanyDetails), null) },
  ({ state, emit }) => ({
    register(input: Infer<typeof CompanyDetails>) {
      if (state.details !== null) return fail(AlreadyRegistered());
      const details = parse(CompanyDetails, input);
      state.details = details;
      emit(CompanyRegistered({ details }));
      return ok(undefined);
    },
  }),
);

const Contact = aggregate(
  "Contact",
  { details: parse(nullable(ContactDetails), null), qualified: false },
  ({ state, emit }) => ({
    register(input: Infer<typeof ContactDetails>) {
      if (state.details !== null) return fail(AlreadyRegistered());
      const details = parse(ContactDetails, input);
      state.details = details;
      emit(ContactRegistered({ details }));
      return ok(undefined);
    },
    qualify() {
      if (state.details === null) return fail(MissingRecord());
      if (state.qualified) return fail(AlreadyQualified());
      state.qualified = true;
      emit(ContactQualified({ details: state.details }));
      return ok(undefined);
    },
  }),
);

const transitions: Record<Stage, readonly Stage[]> = {
  DISCOVERY: ["PROPOSAL", "LOST"],
  PROPOSAL: ["WON", "LOST"],
  WON: [],
  LOST: [],
};
const Deal = aggregate(
  "Deal",
  {
    details: parse(nullable(DealDetails), null),
    stage: parse(Stage, "DISCOVERY"),
    lossReason: "",
  },
  ({ state, emit }) => ({
    open(input: Infer<typeof DealDetails>) {
      if (state.details !== null) return fail(AlreadyRegistered());
      const details = parse(DealDetails, input);
      state.details = details;
      emit(DealChanged({ details, stage: state.stage, lossReason: "" }));
      return ok(undefined);
    },
    move(next: Stage, reason = "") {
      if (state.details === null) return fail(MissingRecord());
      const stage = parse(Stage, next);
      if (!transitions[state.stage].includes(stage)) {
        return fail(InvalidTransition({ from: state.stage, to: stage }));
      }
      if (stage === "LOST" && !reason.trim()) return fail(LossReasonRequired());
      state.stage = stage;
      state.lossReason = stage === "LOST" ? reason.trim() : "";
      emit(
        DealChanged({
          details: state.details,
          stage,
          lossReason: state.lossReason,
        }),
      );
      if (stage === "WON") emit(DealWon({ details: state.details }));
      return ok({ stage });
    },
  }),
);

const DealCard = view(
  "DealCard",
  {
    from: Deal,
    initial: {
      details: parse(nullable(DealDetails), null),
      stage: parse(Stage, "DISCOVERY"),
      lossReason: "",
    },
  },
  on(DealChanged, (_state, { details, stage, lossReason }) => ({
    details,
    stage,
    lossReason,
  })),
);

type Task = {
  kind: "FOLLOW_UP" | "ONBOARDING";
  eventId: string;
  ownerId: string;
  subject: string;
  targetType: "contact" | "deal";
  targetId: string;
  dueAt: number;
};
type PipelineRow = Infer<typeof DealDetails> & {
  dealId: string;
  sequence: number;
  stage: Stage;
  lossReason: string;
};
const Tasks = service("CRM/Tasks", {
  schedule: {
    parse(value: unknown) {
      if (typeof value !== "function")
        throw new TypeError("Expected schedule(task)");
      return value as (task: Task) => Result<void, Unexpected>;
    },
  },
});
const DealIndex = service("CRM/DealIndex", {
  upsert: {
    parse(value: unknown) {
      if (typeof value !== "function")
        throw new TypeError("Expected upsert(rows)");
      return value as (
        rows: readonly PipelineRow[],
      ) => Result<void, Unexpected>;
    },
  },
});

// New policy syntax: payload first, services second, envelope metadata third.
const FollowUpQualifiedContact = policy(
  "FollowUpQualifiedContact",
  { from: Contact, uses: { tasks: Tasks } },
  on(ContactQualified, (event, { tasks }, { id, source, at }) =>
    tasks.schedule({
      kind: "FOLLOW_UP",
      eventId: id,
      ownerId: event.details.ownerId,
      subject: `Contact ${event.details.firstName} about an opportunity`,
      targetType: "contact",
      targetId: source.id,
      dueAt: at + 86_400_000,
    }),
  ),
);
const HandoffWonDeal = policy(
  "HandoffWonDeal",
  { from: Deal, uses: { tasks: Tasks } },
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

// Projection handlers currently receive batches of envelopes through the contract API.
const SearchablePipeline = projection(
  "SearchablePipeline",
  {
    from: Deal,
    on: [DealChanged],
    uses: { index: DealIndex },
    batch: { size: 100 },
  },
  (batch, { index }) =>
    index.upsert(
      batch.map(({ source, seq, event }) => ({
        dealId: source.id,
        sequence: seq,
        ...event.details,
        stage: event.stage,
        lossReason: event.lossReason,
      })),
    ),
);
const CRMModel = model("CRM", {
  aggregates: { company: Company, contact: Contact, deal: Deal },
  views: { dealCard: DealCard },
  policies: [FollowUpQualifiedContact, HandoffWonDeal],
  projections: [SearchablePipeline],
});

function createCRM(storage: SQLiteStore) {
  const db = storage.database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_tasks (
      kind TEXT NOT NULL, event_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      subject TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      PRIMARY KEY(kind, event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS crm_pipeline (
      deal_id TEXT PRIMARY KEY, event_seq INTEGER NOT NULL,
      title TEXT NOT NULL, company_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL, stage TEXT NOT NULL, expected_close TEXT NOT NULL,
      loss_reason TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS crm_pipeline_owner_stage ON crm_pipeline(owner_id, stage);
  `);
  const insertTask = db.prepare(`
    INSERT INTO crm_tasks(kind, event_id, owner_id, subject, target_type, target_id, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, event_id) DO NOTHING
  `);
  const upsertDeal = db.prepare(`
    INSERT INTO crm_pipeline(
      deal_id, event_seq, title, company_id, contact_id, owner_id,
      amount, currency, stage, expected_close, loss_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deal_id) DO UPDATE SET
      event_seq = excluded.event_seq, title = excluded.title,
      company_id = excluded.company_id, contact_id = excluded.contact_id,
      owner_id = excluded.owner_id, amount = excluded.amount,
      currency = excluded.currency, stage = excluded.stage,
      expected_close = excluded.expected_close, loss_reason = excluded.loss_reason
    WHERE excluded.event_seq > crm_pipeline.event_seq
  `);
  // No BEGIN/COMMIT here: the runtime owns the transaction on this connection.
  const tasks = {
    schedule(task: Task) {
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
  const index = {
    upsert(rows: readonly PipelineRow[]) {
      return trycatch(() => {
        for (const row of rows)
          upsertDeal.run(
            row.dealId,
            row.sequence,
            row.title,
            row.companyId,
            row.contactId,
            row.ownerId,
            row.amount,
            row.currency,
            row.stage,
            row.expectedClose,
            row.lossReason,
          );
      });
    },
  };
  return wire(CRMModel, { storage, services: { tasks, index } });
}

function value<T, E extends Tagged>(result: Result<T, E>): T {
  if (result[1] !== null) throw result[1];
  return result[0] as T;
}

async function salesFlow(crm: ReturnType<typeof createCRM>) {
  // Each command commits separately. Reads let this demo resume an interrupted flow.
  if (value(await crm.company.get("company-1")).details === null) {
    value(
      await crm.company.register("company-1", {
        name: "Acme",
        website: "https://acme.example",
        industry: "Manufacturing",
        country: "BR",
        employeeCount: 120,
      }),
    );
  }
  if (value(await crm.contact.get("contact-1")).details === null) {
    value(
      await crm.contact.register("contact-1", {
        firstName: "Ana",
        lastName: "Silva",
        email: "ana@acme.example",
        phone: "+55 11 5555-0100",
        title: "Operations Director",
        companyId: "company-1",
        ownerId: "rep-7",
        marketingConsent: true,
      }),
    );
  }
  if (!value(await crm.contact.get("contact-1")).qualified) {
    value(await crm.contact.qualify("contact-1"));
  }
  const contact = value(await crm.contact.get("contact-1"));
  if (contact.details === null || !contact.qualified)
    throw ContactNotQualified();
  const company = value(await crm.company.get(contact.details.companyId));
  if (company.details === null) throw MissingRecord();
  if (value(await crm.deal.get("deal-1")).details === null) {
    value(
      await crm.deal.open("deal-1", {
        title: "Acme annual subscription",
        companyId: contact.details.companyId,
        contactId: "contact-1",
        ownerId: contact.details.ownerId,
        amount: 2_400_000,
        currency: "BRL",
        expectedClose: "2026-12-15",
      }),
    );
  }
  if (value(await crm.deal.get("deal-1")).stage === "DISCOVERY") {
    value(await crm.deal.move("deal-1", "PROPOSAL"));
  }
  if (value(await crm.deal.get("deal-1")).stage === "PROPOSAL") {
    value(await crm.deal.move("deal-1", "WON"));
  }
}

async function main() {
  const filename = process.argv[2] ?? "crm.sqlite";
  const action = process.argv[3] ?? "drain";
  if (!["seed", "drain", "show"].includes(action))
    throw new Error("Choose seed, drain, or show");

  using storage = sqlite(filename);
  const crm = createCRM(storage);
  if (action === "seed") {
    await salesFlow(crm);
    console.log(
      "Sales flow committed. Exit before flush; run drain to recover pending consumers.",
    );
  }
  if (action === "drain") value(await crm.flush());

  console.log("Deal state:", value(await crm.deal.get("deal-1")));
  console.log("Deal card:", value(await crm.dealCard.get("deal-1")));
  console.table(
    storage.database
      .prepare(
        `
  SELECT deal_id, event_seq, title, owner_id, amount, currency, stage FROM crm_pipeline ORDER BY deal_id
`,
      )
      .all(),
  );
  console.table(
    storage.database
      .prepare(
        `
    SELECT kind, owner_id, target_id, subject, due_at, status FROM crm_tasks ORDER BY kind, event_id
  `,
      )
      .all(),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

export {
  Company,
  Contact,
  CompanyDetails,
  ContactDetails,
  DealDetails,
  DealChanged,
  DealWon,
  ContactQualified,
  FollowUpQualifiedContact,
  Tasks,
  Text,
  PositiveInteger,
  Currency,
  Stage,
  AlreadyRegistered,
  MissingRecord,
  InvalidTransition,
  LossReasonRequired,
  value,
  createCRM,
  salesFlow,
};
export type { Task };
