import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import { validateExpenseForm, type ExpenseFormValues, type StoredExpense } from "@/lib/ledger";
import {
  claimConfirm,
  findFlow,
  finishConfirm,
  releaseConfirm,
} from "@/server/telegram/split-store";
import { FakeTelegram, type FakeMessage } from "@/test-support/fake-telegram";
import { callbackUpdate, textUpdate } from "@/test-support/telegram-updates";
import { closeTestDb, resetDatabase, testDb } from "./helpers";
import { storeFor } from "./ledger-support";
import { GROUP_CHAT, PEOPLE, setupBotWorld, type BotWorld } from "./telegram-support";

const db = testDb();
const fake = new FakeTelegram("123456:TEST-bot-token-for-lullet-tests-only");
let world: BotWorld;

beforeAll(() => fake.start());
afterAll(async () => {
  await fake.stop();
  await closeTestDb();
});
beforeEach(async () => {
  fake.reset();
  await resetDatabase(db);
  world = await setupBotWorld(db, fake);
});

const [ALEX, MEI, DAD] = [0, 1, 3] as const;

const ledger = async (): Promise<StoredExpense[]> =>
  storeFor(db, { groupId: world.groupId, userIds: world.userIds }, { as: 0 }).listExpenses();
const flows = () => db.select().from(s.telegramSplitFlows);
const last = (who: number) => world.draftMessage(who);
const split = (who: number) => world.say(who, "/split");
const tap = (who: number, label: string, message: FakeMessage = last(who)) =>
  world.tap(who, message, label);

/** Types an answer and returns the question the bot asked next. */
async function answer(who: number, text: string): Promise<FakeMessage> {
  await world.say(who, text);
  return last(who);
}

describe("starting /split", () => {
  it("asks for the title first, in the private chat, with a Cancel button", async () => {
    await split(ALEX);
    const question = last(ALEX);
    expect(question.chatId).toBe(PEOPLE[ALEX].telegramId);
    expect(question.text).toContain("What was it for");
    expect(fake.hasButton(question, "Cancel")).toBe(true);
    expect(await flows()).toHaveLength(1);
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(0);
  });

  it("only points to the private chat when asked in the group, and starts nothing", async () => {
    await world.say(ALEX, "/split", { group: true });
    const reply = fake.lastTo(GROUP_CHAT);
    expect(reply.text).toContain("/split works in a private chat");
    expect(reply.text.length).toBeLessThan(160);
    expect(await flows()).toHaveLength(0);
    expect(fake.messagesTo(PEOPLE[ALEX].telegramId)).toHaveLength(0);
  });

  it("is silent towards anyone who is not a member of the group", async () => {
    const stranger = { fromId: 4242, chatId: 4242, chatType: "private" as const };
    await world.send(textUpdate(stranger, "/split"));
    await world.send(textUpdate(stranger, "hello"));
    expect(fake.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    expect(await flows()).toHaveLength(0);
  });

  it("ignores ordinary messages when no /split is open, as before", async () => {
    await world.say(ALEX, "hello there");
    expect(fake.messagesTo(PEOPLE[ALEX].telegramId)).toHaveLength(0);
  });

  it("is listed in the help", async () => {
    await world.say(ALEX, "/help");
    expect(last(ALEX).text).toContain("/split");
    expect(last(ALEX).text).toContain("/cancel");
  });
});

describe("the simplest expense: everything left at its default", () => {
  it("walks every question, adds one equal expense and tells the group", async () => {
    await split(ALEX);
    const title = last(ALEX);
    let question = await answer(ALEX, "Dinner at Luigi's");
    expect(title.text).toBe("Expense: <b>Dinner at Luigi's</b>");
    expect(title.keyboard).toHaveLength(0);

    expect(question.text).toContain("How much was it?");
    expect(fake.callbackFor(question, "EUR")).toBeTruthy();
    question = await answer(ALEX, "45");
    expect(question.text).toContain("Who paid?");
    expect(question.keyboard.flat().map((b) => b.text)).toContain("✓ Alex");

    await tap(ALEX, "Done");
    question = last(ALEX);
    expect(question.text).toContain("Who shared it?");
    expect(question.keyboard.flat().filter((b) => b.text.startsWith("✓"))).toHaveLength(4);

    await tap(ALEX, "Done");
    expect(last(ALEX).text).toContain("How should it be split?");
    await tap(ALEX, "Equally");
    expect(last(ALEX).text).toContain("When was it?");
    await tap(ALEX, "Today");
    expect(last(ALEX).text).toContain("Pick a category");
    await tap(ALEX, "Skip");

    const summary = last(ALEX);
    expect(summary.text).toContain("Check this expense");
    expect(summary.text).toContain("Dinner at Luigi&#39;s".replace("&#39;", "'"));
    expect(summary.text).toContain("S$45.00 on Sun 8 Nov, Food");
    expect(summary.text).toContain("Paid by Alex");
    expect(summary.text).toContain(
      "Split equally: Alex S$11.25, Mei S$11.25, Mum S$11.25, Dad S$11.25",
    );
    expect(await ledger()).toHaveLength(0);

    await tap(ALEX, "Confirm");
    expect(summary.text).toContain("<b>Added</b>");
    expect(fake.hasButton(summary, "Open in app")).toBe(true);
    expect(fake.answers.at(-1)?.text).toBe("Added");

    const [expense] = await ledger();
    expect(expense).toMatchObject({
      description: "Dinner at Luigi's",
      amountMinor: 4500,
      currency: "SGD",
      category: "food",
      spentOn: "2026-11-08",
      splitMethod: "equal",
      createdBy: world.userIds[ALEX],
    });
    expect(expense?.payers).toEqual([{ userId: world.userIds[ALEX], amountMinor: 4500 }]);
    expect(expense?.shares.map((x) => x.amountMinor)).toEqual([1125, 1125, 1125, 1125]);
    expect(await flows()).toHaveLength(0);

    // The group is told exactly as for an expense added in the web form.
    const note = fake.lastTo(GROUP_CHAT);
    expect(note.text).toContain("<b>Alex</b> added Dinner at Luigi's, S$45.00 (paid by Alex).");

    // The change is audit-logged by the same store.
    const audit = await db
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.entityId, expense?.id ?? ""));
    expect(audit.map((row) => row.action)).toEqual(["expense.create"]);
    expect(audit[0]?.actorUserId).toBe(world.userIds[ALEX]);
  });
});

describe("percent, several payers and a foreign currency", () => {
  /** Hotel, 200 EUR: Alex 120 and Mei 80 paid; Alex, Mei and Mum share 50/30/20; 5 Nov; Stay. */
  async function hotel(): Promise<FakeMessage> {
    await split(ALEX);
    await answer(ALEX, "Hotel");
    await answer(ALEX, "200 EUR");
    await tap(ALEX, "Mei");
    expect(
      last(ALEX)
        .keyboard.flat()
        .map((b) => b.text),
    ).toContain("✓ Mei");
    await tap(ALEX, "Done");
    const asked = last(ALEX);
    expect(asked.text).toContain("How much did each person pay?");
    expect(asked.text).toContain("The total is €200.00");
    expect(asked.text).toContain("Alex, Mei");
    await answer(ALEX, "120 80");
    await tap(ALEX, "Dad"); // takes Dad off
    await tap(ALEX, "Done");
    expect(last(ALEX).text).toContain("How should it be split?");
    await tap(ALEX, "By percent");
    const values = last(ALEX);
    expect(values.text).toContain("What percent does each person pay?");
    expect(values.text).toContain("Alex, Mei, Mum");
    await answer(ALEX, "50 30");
    await answer(ALEX, "5 Nov");
    await tap(ALEX, "Stay");
    return last(ALEX);
  }

  it("adds the expense with the payers' amounts, percentages and the day's exchange rate", async () => {
    const summary = await hotel();
    expect(summary.text).toContain("€200.00 on Thu 5 Nov, Stay");
    expect(summary.text).toContain("Paid by Alex €120.00, Mei €80.00");
    expect(summary.text).toContain(
      "Split by percent: Alex 50% €100.00, Mei 30% €60.00, Mum 20% €40.00",
    );
    expect(summary.text).toContain("exchange rate");

    await tap(ALEX, "Confirm", summary);
    const [expense] = await ledger();
    const [alex, mei, mum] = world.userIds;
    expect(expense).toMatchObject({
      description: "Hotel",
      amountMinor: 20000,
      currency: "EUR",
      category: "stay",
      spentOn: "2026-11-05",
      splitMethod: "percent",
      pricedRate: "1.5000000000",
      pricedRateCurrency: "EUR",
    });
    expect(expense?.payers).toEqual([
      { userId: alex, amountMinor: 12000 },
      { userId: mei, amountMinor: 8000 },
    ]);
    expect(expense?.shares).toEqual([
      { userId: alex, amountMinor: 10000, weight: 5000 },
      { userId: mei, amountMinor: 6000, weight: 3000 },
      { userId: mum, amountMinor: 4000, weight: 2000 },
    ]);
    expect(fake.lastTo(GROUP_CHAT).text).toContain("paid by Alex, Mei");
  });

  it("splits by exact amounts, letting the last person take the rest", async () => {
    await split(MEI);
    await answer(MEI, "Taxi");
    await answer(MEI, "S$30");
    await tap(MEI, "Done");
    await tap(MEI, "Mum");
    await tap(MEI, "Dad");
    await tap(MEI, "Done");
    await tap(MEI, "Exact amounts");
    expect(last(MEI).text).toContain("They must add up to S$30.00");
    await answer(MEI, "20");
    await tap(MEI, "Yesterday");
    await tap(MEI, "Transport");
    const summary = last(MEI);
    expect(summary.text).toContain("S$30.00 on Sat 7 Nov, Transport");
    expect(summary.text).toContain("Split by exact amounts: Alex S$20.00, Mei S$10.00");
    await tap(MEI, "Confirm", summary);
    const [expense] = await ledger();
    expect(expense?.shares.map((x) => x.amountMinor)).toEqual([2000, 1000]);
    expect(expense?.payers).toEqual([{ userId: world.userIds[MEI], amountMinor: 3000 }]);
  });

  it("splits what several payers paid equally on request", async () => {
    await split(ALEX);
    await answer(ALEX, "Wine");
    await answer(ALEX, "10.01");
    await tap(ALEX, "Mei");
    await tap(ALEX, "Done");
    await tap(ALEX, "Paid equally");
    expect(last(ALEX).text).toContain("Who shared it?");
    await tap(ALEX, "Done");
    await tap(ALEX, "Equally");
    await tap(ALEX, "Today");
    await tap(ALEX, "Skip");
    await tap(ALEX, "Confirm");
    const [expense] = await ledger();
    // Largest remainder: the odd cent goes to the first payer.
    expect(expense?.payers.map((p) => p.amountMinor)).toEqual([501, 500]);
  });

  it("creates exactly what the web form's path creates for the same answers", async () => {
    const summary = await hotel();
    await tap(ALEX, "Confirm", summary);
    const store = storeFor(db, { groupId: world.groupId, userIds: world.userIds }, { as: 0 });
    const [alex, mei, mum, dad] = world.userIds;
    const form: ExpenseFormValues = {
      description: "Hotel",
      spentOn: "2026-11-05",
      category: "stay",
      amount: "200.00",
      currency: "EUR",
      billed: null,
      rate: null,
      payers: [
        { userId: alex ?? "", included: true, amount: "120.00" },
        { userId: mei ?? "", included: true, amount: "80.00" },
        { userId: mum ?? "", included: false, amount: "" },
        { userId: dad ?? "", included: false, amount: "" },
      ],
      split: {
        mode: "percent",
        members: [
          { userId: alex ?? "", included: true, value: "50" },
          { userId: mei ?? "", included: true, value: "30" },
          { userId: mum ?? "", included: true, value: "20" },
          { userId: dad ?? "", included: false, value: "" },
        ],
      },
    };
    const checked = validateExpenseForm(form, world.userIds);
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    const viaForm = await store.createExpense(checked.value);
    const viaBot = (await ledger()).find((e) => e.id !== viaForm.id);
    const comparable = (e: StoredExpense | undefined) =>
      e && { ...e, id: 0, createdAt: 0, updatedAt: 0, importId: null };
    expect(comparable(viaBot)).toEqual(comparable(viaForm));
  });
});

describe("answers the bot cannot accept", () => {
  it("explains a bad title, amount, date and category and asks again", async () => {
    await split(ALEX);
    await answer(ALEX, "x".repeat(130));
    expect(last(ALEX).text).toContain("under 120 characters");
    await answer(ALEX, "Lunch");

    await answer(ALEX, "lots");
    expect(last(ALEX).text).toContain("Try 45, S$45 or 100 EUR");
    await answer(ALEX, "10 XYZ");
    expect(last(ALEX).text).toContain("do not know that currency");
    const question = last(ALEX);
    expect(fake.messagesTo(PEOPLE[ALEX].telegramId).some((m) => m.text.includes("Who paid?"))).toBe(
      false,
    );
    expect(question.text).not.toContain("Who paid?");
    await answer(ALEX, "12");

    await tap(ALEX, "Done");
    await tap(ALEX, "Done");
    await tap(ALEX, "Equally");
    await answer(ALEX, "someday");
    expect(last(ALEX).text).toContain("could not read that date");
    await answer(ALEX, "2026-11-03");
    await answer(ALEX, "fun");
    expect(last(ALEX).text).toContain("Pick one of: Food, Transport");
    await answer(ALEX, "shopping");
    expect(last(ALEX).text).toContain("S$12.00 on Tue 3 Nov, Shopping");
  });

  it("refuses payments, percentages and amounts that do not add up, and keeps asking", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    await answer(ALEX, "100");
    await tap(ALEX, "Mei");
    await tap(ALEX, "Done");
    await answer(ALEX, "60 30");
    expect(last(ALEX).text).toContain("Payments add up to S$90.00, but the expense is S$100.00");
    await answer(ALEX, "60 40 10");
    expect(last(ALEX).text).toContain("Send 2 amounts");
    await answer(ALEX, "60 40");

    await tap(ALEX, "Done");
    await tap(ALEX, "By percent");
    await answer(ALEX, "60 30");
    expect(last(ALEX).text).toContain("Send 4 percentages");
    await answer(ALEX, "50 30 10 5");
    expect(last(ALEX).text).toContain("add up to 100");
    await answer(ALEX, "100 0 0 0");
    expect(last(ALEX).text).toContain("more than 0%");
    expect(last(ALEX).text).not.toContain("When was it?");
    await answer(ALEX, "40 30 20");
    expect(last(ALEX).text).toContain("When was it?");
  });

  it("refuses exact amounts that do not add up", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    await answer(ALEX, "100");
    await tap(ALEX, "Done");
    await tap(ALEX, "Mum");
    await tap(ALEX, "Dad");
    await tap(ALEX, "Done");
    await tap(ALEX, "Exact amounts");
    await answer(ALEX, "70 20");
    expect(last(ALEX).text).toContain("Amounts add up to S$90.00, but the expense is S$100.00");
    await answer(ALEX, "70");
    expect(last(ALEX).text).toContain("When was it?");
  });

  it("will not leave a question without a payer or a sharer", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    await answer(ALEX, "10");
    await tap(ALEX, "Alex"); // takes the only payer off
    await tap(ALEX, "Done");
    expect(fake.answers.at(-1)).toMatchObject({
      text: "Pick at least one person who paid.",
      alert: true,
    });
    expect(last(ALEX).text).toContain("Who paid?");
    await tap(ALEX, "Alex");
    await tap(ALEX, "Mei");
    await tap(ALEX, "Done");
    expect(last(ALEX).text).toContain("How much did each person pay?");
    // Two payers need two amounts; naming only the first gives the second the rest, which is nothing.
    await answer(ALEX, "10");
    expect(last(ALEX).text).toContain("already add up");
  });

  it("answers a typed message at a button question with a hint", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    await answer(ALEX, "10");
    await answer(ALEX, "Alex paid");
    expect(last(ALEX).text).toBe("Use the buttons above to answer, or /cancel to stop.");
  });

  it("uses the typed currency for the amount and the button for a bare number", async () => {
    await split(ALEX);
    await answer(ALEX, "Snack");
    await tap(ALEX, "CHF");
    expect(
      last(ALEX)
        .keyboard.flat()
        .map((b) => b.text),
    ).toContain("✓ CHF");
    await answer(ALEX, "12");
    await tap(ALEX, "Done");
    await tap(ALEX, "Done");
    await tap(ALEX, "Equally");
    await tap(ALEX, "Today");
    await tap(ALEX, "Skip");
    expect(last(ALEX).text).toMatch(/CHF\s12\.00/);
  });
});

describe("editing before confirming", () => {
  async function toSummary(): Promise<FakeMessage> {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    await answer(ALEX, "100");
    await tap(ALEX, "Mei");
    await tap(ALEX, "Done");
    await answer(ALEX, "70 30");
    await tap(ALEX, "Done");
    await tap(ALEX, "Equally");
    await tap(ALEX, "Today");
    await tap(ALEX, "Skip");
    return last(ALEX);
  }

  it("changes one answer and comes back to the summary", async () => {
    const summary = await toSummary();
    await tap(ALEX, "Edit", summary);
    expect(summary.text).toContain("What do you want to change?");
    expect(summary.keyboard.flat().map((b) => b.text)).toContain("Split");

    await tap(ALEX, "Title", summary);
    expect(summary.text).toContain("What was it for?");
    await answer(ALEX, "Late dinner");
    expect(last(ALEX).text).toContain("<b>Late dinner</b>");
    expect(last(ALEX).text).toContain("Check this expense");
    expect(
      last(ALEX)
        .keyboard.flat()
        .map((b) => b.text),
    ).toEqual(["Confirm", "Edit", "Cancel"]);
  });

  it("asks again for the payers' amounts when the total changes", async () => {
    const summary = await toSummary();
    await tap(ALEX, "Edit", summary);
    await tap(ALEX, "Amount", summary);
    await answer(ALEX, "50");
    expect(last(ALEX).text).toContain("How much did each person pay?");
    expect(last(ALEX).text).toContain("The total is S$50.00");
    await tap(ALEX, "Paid equally");
    const again = last(ALEX);
    expect(again.text).toContain("Paid by Alex S$25.00, Mei S$25.00");
    await tap(ALEX, "Confirm");
    const [expense] = await ledger();
    expect(expense?.amountMinor).toBe(5000);
    expect(expense?.payers.map((p) => p.amountMinor)).toEqual([2500, 2500]);
  });

  it("asks for new percentages after the sharers change", async () => {
    const summary = await toSummary();
    await tap(ALEX, "Edit", summary);
    await tap(ALEX, "Split", summary);
    await tap(ALEX, "By percent", summary);
    await answer(ALEX, "10 20 30 40");
    expect(last(ALEX).text).toContain("Split by percent: Alex 10% S$10.00");

    await tap(ALEX, "Edit");
    await tap(ALEX, "Shared by");
    await tap(ALEX, "Dad");
    await tap(ALEX, "Done");
    expect(last(ALEX).text).toContain("What percent does each person pay?");
    expect(last(ALEX).text).toContain("Alex, Mei, Mum");
    await answer(ALEX, "50 25 25");
    expect(last(ALEX).text).toContain("Alex 50% S$50.00, Mei 25% S$25.00, Mum 25% S$25.00");
  });

  it("goes Back without changing anything", async () => {
    const summary = await toSummary();
    await tap(ALEX, "Edit", summary);
    await tap(ALEX, "Back", summary);
    expect(summary.text).toContain("Check this expense");
    expect(summary.keyboard.flat().map((b) => b.text)).toEqual(["Confirm", "Edit", "Cancel"]);
  });
});

describe("stopping", () => {
  it("cancels with the button and adds nothing", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    const question = last(ALEX);
    await tap(ALEX, "Cancel");
    expect(question.text).toBe("Cancelled. Nothing was added.");
    expect(question.keyboard).toHaveLength(0);
    expect(await flows()).toHaveLength(0);
    expect(await ledger()).toHaveLength(0);
    // Nothing is listening for answers any more.
    const before = fake.messagesTo(PEOPLE[ALEX].telegramId).length;
    await world.say(ALEX, "45");
    expect(fake.messagesTo(PEOPLE[ALEX].telegramId)).toHaveLength(before);
  });

  it("cancels with /cancel from any question, and says so when there is nothing to cancel", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    const question = last(ALEX);
    await world.say(ALEX, "/cancel");
    expect(question.text).toBe("Cancelled.");
    expect(last(ALEX).text).toBe("Cancelled. Nothing was added.");
    expect(await flows()).toHaveLength(0);
    await world.say(ALEX, "/cancel");
    expect(last(ALEX).text).toContain("nothing to cancel");
  });

  it("forgets a flow nobody answers for 30 minutes, and tells a late answer so", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    const question = last(ALEX);
    world.clock.now = new Date(world.clock.now.getTime() + 29 * 60_000);
    expect((await answer(ALEX, "10")).text).toContain("Who paid?");
    world.clock.now = new Date(world.clock.now.getTime() + 31 * 60_000);

    await world.say(ALEX, "late");
    expect(last(ALEX).text).toContain("ran out of time");
    expect(await flows()).toHaveLength(0);
    expect(question.keyboard).toHaveLength(0);

    await split(ALEX);
    const old = last(ALEX);
    world.clock.now = new Date(world.clock.now.getTime() + 31 * 60_000);
    await tap(ALEX, "Cancel", old);
    expect(old.text).toContain("ran out of time");
    expect(fake.answers.at(-1)?.alert).toBe(true);
    expect(await ledger()).toHaveLength(0);
  });

  it("keeps each member's flow separate", async () => {
    await split(ALEX);
    await split(MEI);
    await answer(ALEX, "Alex's dinner");
    await answer(MEI, "Mei's taxi");
    expect(await flows()).toHaveLength(2);
    await world.say(ALEX, "/cancel");
    expect(await flows()).toHaveLength(1);
    expect((await answer(MEI, "20")).text).toContain("Who paid?");
  });
});

describe("old and forged buttons", () => {
  it("starting again replaces the flow and silences the old buttons", async () => {
    await split(ALEX);
    await answer(ALEX, "First");
    const oldQuestion = last(ALEX);
    const oldData = fake.callbackFor(oldQuestion, "Cancel");
    await split(ALEX);
    expect(await flows()).toHaveLength(1);
    await world.send(
      callbackUpdate(world.where(ALEX), { messageId: oldQuestion.messageId, data: oldData }),
    );
    expect(fake.answers.at(-1)).toMatchObject({
      text: "That is from an earlier /split.",
      alert: true,
    });
    expect(await flows()).toHaveLength(1);
  });

  it("does not let a button for an answered question change anything", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    await answer(ALEX, "10");
    const payers = last(ALEX);
    const done = fake.callbackFor(payers, "Done");
    await tap(ALEX, "Done");
    expect(last(ALEX).text).toContain("Who shared it?");
    await world.send(
      callbackUpdate(world.where(ALEX), { messageId: payers.messageId, data: done }),
    );
    expect(fake.answers.at(-1)?.text).toBe("That question was already answered.");
    expect(last(ALEX).text).toContain("Who shared it?");
  });

  it("refuses data this server did not sign and buttons tapped in the group", async () => {
    await split(ALEX);
    const question = last(ALEX);
    const data = fake.callbackFor(question, "Cancel");
    await world.send(
      callbackUpdate(world.where(ALEX), {
        messageId: question.messageId,
        data: `${data.slice(0, -1)}x`,
      }),
    );
    expect(fake.answers.at(-1)).toMatchObject({
      text: "This button is no longer valid.",
      alert: true,
    });
    await world.send(
      callbackUpdate(world.where(ALEX, true), { messageId: question.messageId, data }),
    );
    expect(fake.answers.at(-1)).toMatchObject({
      text: "This button is no longer valid.",
      alert: true,
    });
    expect(await flows()).toHaveLength(1);
  });

  it("does not let another member act on someone's flow", async () => {
    await split(ALEX);
    const question = last(ALEX);
    const data = fake.callbackFor(question, "Cancel");
    await world.send(callbackUpdate(world.where(MEI), { messageId: question.messageId, data }));
    expect(fake.answers.at(-1)?.alert).toBe(true);
    expect(await flows()).toHaveLength(1);
  });
});

describe("confirming", () => {
  async function toSummary(who: number = ALEX, amount = "45"): Promise<FakeMessage> {
    await split(who);
    await answer(who, "Dinner");
    await answer(who, amount);
    await tap(who, "Done");
    await tap(who, "Done");
    await tap(who, "Equally");
    await tap(who, "Today");
    await tap(who, "Skip");
    return last(who);
  }

  it("adds the expense once however many times Confirm is tapped", async () => {
    const summary = await toSummary();
    const data = fake.callbackFor(summary, "Confirm");
    const tapOnce = (queryId: string) =>
      world.send(
        callbackUpdate(world.where(ALEX), { messageId: summary.messageId, data, queryId }),
      );
    await Promise.all([tapOnce("q1"), tapOnce("q2")]);
    await tapOnce("q3");
    expect(await ledger()).toHaveLength(1);
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(1);
    expect(await flows()).toHaveLength(0);
  });

  it("does not drop the flow on /cancel while the expense is being added", async () => {
    await toSummary();
    await db.update(s.telegramSplitFlows).set({ step: "confirming" });
    await world.say(ALEX, "/cancel");
    expect(last(ALEX).text).toBe("One moment, I am adding it.");
    expect(await flows()).toHaveLength(1);
    expect((await flows())[0]?.step).toBe("confirming");
  });

  describe("a Confirm that outlives its claim", () => {
    const advance = (ms: number) => {
      world.clock.now = new Date(world.clock.now.getTime() + ms);
    };
    const who = () => ({ groupId: world.groupId, userId: world.userIds[ALEX] ?? "" });
    const openFlow = async () => {
      const found = await findFlow(db, who(), world.clock.now);
      if (found.kind !== "open") throw new Error("no open flow");
      return found.flow;
    };

    it("saves nothing when the flow was released and claimed again during the save", async () => {
      await split(ALEX);
      await answer(ALEX, "Souvenir");
      await answer(ALEX, "20 EUR");
      await tap(ALEX, "Done");
      await tap(ALEX, "Done");
      await tap(ALEX, "Equally");
      await tap(ALEX, "Today");
      await tap(ALEX, "Skip");
      const summary = last(ALEX);
      const fx = world.deps.fx;
      const real = fx.getRate.bind(fx);
      vi.spyOn(fx, "getRate").mockImplementationOnce(async (...args) => {
        advance(121_000);
        await openFlow();
        return real(...args);
      });
      await tap(ALEX, "Confirm", summary);
      expect(fake.answers.at(-1)?.text).toContain("nothing was added");
      expect(await ledger()).toHaveLength(0);
      expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(0);
      expect((await flows())[0]?.step).toBe("summary");

      await tap(ALEX, "Confirm", summary);
      expect(await ledger()).toHaveLength(1);
      expect(await flows()).toHaveLength(0);
    });

    it("lets only the current claim release or finish the flow", async () => {
      await toSummary();
      const first = await claimConfirm(db, await openFlow(), world.clock.now);
      advance(121_000);
      const second = await claimConfirm(db, await openFlow(), world.clock.now);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      if (first === null || second === null) return;

      const id = (await flows())[0]?.id ?? "";
      await releaseConfirm(db, id, first, world.clock.now);
      expect((await flows())[0]?.step).toBe("confirming");
      expect(await finishConfirm(db, id, first)).toBe(false);
      expect(await flows()).toHaveLength(1);
      expect(await finishConfirm(db, id, second)).toBe(true);
      expect(await flows()).toHaveLength(0);
    });

    it("leaves no flow behind once the expense is saved, so a late Confirm adds nothing", async () => {
      const summary = await toSummary();
      const data = fake.callbackFor(summary, "Confirm");
      const confirmAgain = () =>
        world.send(callbackUpdate(world.where(ALEX), { messageId: summary.messageId, data }));
      await confirmAgain();
      expect(await flows()).toHaveLength(0);
      advance(10 * 60_000);
      await confirmAgain();
      expect(fake.answers.at(-1)?.text).toContain("already finished");
      expect(await ledger()).toHaveLength(1);
    });
  });

  describe("a Confirm whose handler never finished", () => {
    const advance = (ms: number) => {
      world.clock.now = new Date(world.clock.now.getTime() + ms);
    };
    const stuckConfirm = async (): Promise<FakeMessage> => {
      const summary = await toSummary();
      await db.update(s.telegramSplitFlows).set({ step: "confirming", updatedAt: world.clock.now });
      return summary;
    };

    it("is still being added under two minutes: /cancel, text and taps wait", async () => {
      const summary = await stuckConfirm();
      advance(119_000);
      await world.say(ALEX, "/cancel");
      expect(last(ALEX).text).toBe("One moment, I am adding it.");
      await world.say(ALEX, "hello");
      expect(last(ALEX).text).toBe("One moment, I am adding it.");
      await tap(ALEX, "Confirm", summary);
      expect(fake.answers.at(-1)?.text).toBe("Adding it now...");
      expect((await flows())[0]?.step).toBe("confirming");
      expect(await ledger()).toHaveLength(0);
    });

    it("can be cancelled after two minutes", async () => {
      await stuckConfirm();
      advance(121_000);
      await world.say(ALEX, "/cancel");
      expect(last(ALEX).text).toBe("Cancelled. Nothing was added.");
      expect(await flows()).toHaveLength(0);
      expect(await ledger()).toHaveLength(0);
    });

    it("can be confirmed again after two minutes, and adds the expense once", async () => {
      const summary = await stuckConfirm();
      const data = fake.callbackFor(summary, "Confirm");
      const confirmAgain = () =>
        world.send(callbackUpdate(world.where(ALEX), { messageId: summary.messageId, data }));
      advance(121_000);
      await confirmAgain();
      await confirmAgain();
      expect(await ledger()).toHaveLength(1);
      expect(await flows()).toHaveLength(0);
      expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(1);
    });

    it("starts a fresh /split after two minutes", async () => {
      await stuckConfirm();
      advance(121_000);
      await split(ALEX);
      expect(last(ALEX).text).toContain("What was it for");
      expect((await flows())[0]?.step).toBe("title");
      expect(await ledger()).toHaveLength(0);
    });
  });

  it("keeps the summary when no exchange rate can be had, and adds it on a retry", async () => {
    await split(ALEX);
    await answer(ALEX, "Souvenir");
    await answer(ALEX, "20 GBP");
    await tap(ALEX, "Done");
    await tap(ALEX, "Done");
    await tap(ALEX, "Equally");
    await tap(ALEX, "Today");
    await tap(ALEX, "Skip");
    const summary = last(ALEX);
    await tap(ALEX, "Confirm", summary);
    expect(fake.answers.at(-1)?.alert).toBe(true);
    expect(fake.answers.at(-1)?.text).toContain("GBP to SGD rate");
    expect(await ledger()).toHaveLength(0);
    expect(summary.text).toContain("Check this expense");
    expect((await flows())[0]?.step).toBe("summary");

    await world.say(ALEX, "/rate GBP 1.7");
    await tap(ALEX, "Confirm", summary);
    expect(await ledger()).toHaveLength(1);
  });

  it("lets the member leave and come back: the flow survives between messages", async () => {
    await split(ALEX);
    await answer(ALEX, "Dinner");
    const rows = await flows();
    expect(rows[0]).toMatchObject({ step: "amount", userId: world.userIds[ALEX] });
    expect(rows[0]?.state).toMatchObject({ title: "Dinner" });
    // A different server instance has no memory of the conversation; only the database remains.
    expect((await answer(ALEX, "45")).text).toContain("Who paid?");
  });

  it("works for each member as the payer by default", async () => {
    const summary = await toSummary(DAD, "8.80");
    await tap(DAD, "Confirm", summary);
    const [expense] = await ledger();
    expect(expense?.payers).toEqual([{ userId: world.userIds[DAD], amountMinor: 880 }]);
    expect(fake.lastTo(GROUP_CHAT).text).toContain("<b>Dad</b> added");
  });
});
