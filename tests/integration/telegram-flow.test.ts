import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { FakeTelegram } from "@/test-support/fake-telegram";
import { callbackUpdate } from "@/test-support/telegram-updates";
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

const [ALEX, MEI, MUM, DAD] = [0, 1, 2, 3] as const;
const alexChat = PEOPLE[ALEX].telegramId;

const ledger = async () =>
  storeFor(db, { groupId: world.groupId, userIds: world.userIds }, { as: 0 }).listExpenses();

describe("a screenshot sent to the bot in a private chat", () => {
  it("acknowledges at once, then edits the same message into the draft summary", async () => {
    await world.photo(ALEX);
    const messages = fake.messagesTo(alexChat);
    expect(messages).toHaveLength(1);
    const draft = messages[0];
    expect(draft?.edits).toBe(1);
    expect(fake.callsTo("sendMessage")[0]?.params.text).toBe("Reading your screenshot...");
    expect(draft?.text).toContain("Draft from your screenshot");
    expect(draft?.text).toContain("Trattoria Roma, €48.50, Food");
    expect(draft?.text).toContain("Paid by Alex");
    expect(draft?.text).toContain("€148.49");
    expect(fake.hasButton(draft!, "Confirm 4")).toBe(true);
    expect(fake.hasButton(draft!, "Edit rows")).toBe(true);
    expect(fake.hasButton(draft!, "Cancel")).toBe(true);
    const app = draft?.keyboard.flat().find((b) => b.text === "Open in app");
    expect(app?.web_app?.url).toMatch(/^https:\/\/lullet\.test\/signin\?next=%2Fimports%2F/);
    // Nothing reaches the group until the draft is confirmed.
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(0);
    expect(await ledger()).toHaveLength(0);
  });

  it("walks the whole flow: edit a row, confirm, announce to the group, undo", async () => {
    await world.photo(ALEX);
    let draft = world.draftMessage(ALEX);

    await world.tap(ALEX, draft, "Edit rows");
    expect(draft.text).toContain("Row 1 of 4");
    for (let i = 0; i < 3; i += 1) await world.tap(ALEX, draft, "Next");
    expect(draft.text).toContain("Row 4 of 4");
    expect(draft.text).toContain("Louvre");
    // Take Mei off the Louvre: the row is shared by Mum and Dad only.
    await world.tap(ALEX, draft, "Mei");
    expect(draft.text).toContain("Shared equally between Mum, Dad");
    await world.tap(ALEX, draft, "Summary");
    expect(draft.text).toContain("Louvre, €64.00, Sightseeing, Mum, Dad");

    await world.tap(ALEX, draft, "Confirm 4");
    draft = world.draftMessage(ALEX);
    expect(draft.text).toContain("Added 4 expenses");
    expect(fake.hasButton(draft, "Undo")).toBe(true);
    expect(await ledger()).toHaveLength(4);
    const louvre = (await ledger()).find((e) => e.description === "Louvre");
    expect(louvre?.shares.map((x) => x.amountMinor).sort()).toEqual([3200, 3200]);

    const announcement = fake.lastTo(GROUP_CHAT);
    expect(announcement.text).toContain("Alex");
    expect(announcement.text).toContain("4 expenses from a screenshot");
    expect(announcement.keyboard).toHaveLength(0);

    await world.tap(ALEX, draft, "Undo");
    expect(draft.text).toContain("Undone");
    expect(draft.keyboard).toHaveLength(0);
    expect(await ledger()).toHaveLength(0);
    // The others who shared in the expenses are told privately (decision D6).
    for (const other of [MEI, MUM, DAD]) {
      expect(fake.lastTo(PEOPLE[other].telegramId).text).toContain("undid an import");
    }
    expect(fake.messagesTo(alexChat).at(-1)?.text).not.toContain("undid an import");
  });

  it("confirms only once however many times Confirm is tapped", async () => {
    await world.photo(ALEX);
    const draft = world.draftMessage(ALEX);
    const data = fake.callbackFor(draft, "Confirm");
    await world.send(
      callbackUpdate(world.where(ALEX), { messageId: draft.messageId, data, queryId: "q1" }),
    );
    await world.send(
      callbackUpdate(world.where(ALEX), { messageId: draft.messageId, data, queryId: "q2" }),
    );
    expect(await ledger()).toHaveLength(4);
    expect(fake.answers.map((a) => a.text)).toEqual(["Added 4", "Already added"]);
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(1);
  });

  it("refuses Confirm from anyone but the uploader and changes nothing", async () => {
    await world.photo(ALEX);
    const draft = world.draftMessage(ALEX);
    const data = fake.callbackFor(draft, "Confirm");
    // Mei somehow holds Alex's button (a forwarded message) and taps it in her own chat.
    await world.send(callbackUpdate(world.where(MEI), { messageId: 777, data, queryId: "mei" }));
    expect(fake.answers.at(-1)).toEqual({
      id: "mei",
      text: "Only Alex can do that with this import.",
      alert: true,
    });
    expect(await ledger()).toHaveLength(0);
    const [row] = await db.select().from(s.imports);
    expect(row?.status).toBe("draft");
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(0);
  });

  it("rejects buttons the server did not mint", async () => {
    await world.photo(ALEX);
    const draft = world.draftMessage(ALEX);
    const real = fake.callbackFor(draft, "Confirm");
    const forged = `${real.slice(0, real.lastIndexOf(":") + 1)}AAAAAAAA`;
    await world.send(
      callbackUpdate(world.where(ALEX), { messageId: draft.messageId, data: forged, queryId: "f" }),
    );
    expect(fake.answers.at(-1)?.alert).toBe(true);
    expect(await ledger()).toHaveLength(0);
  });

  it("applies the caption: who shares, who paid, and says what it could not read", async () => {
    await world.photo(ALEX, { caption: "split between mei and dad, paid by mum, also bob" });
    const draft = world.draftMessage(ALEX);
    expect(draft.text).toContain("Paid by Mum");
    expect(draft.text).toContain("Trattoria Roma, €48.50, Food, Mei, Dad");
    expect(draft.text).toContain("I did not recognise: bob");
    const [row] = await db.select().from(s.imports);
    expect(row?.caption).toBe("split between mei and dad, paid by mum, also bob");
  });

  it("explains a duplicate upload instead of reading it twice", async () => {
    await world.photo(ALEX, { seed: 9 });
    await world.photo(ALEX, { seed: 9 });
    expect(fake.messagesTo(alexChat).at(-1)?.text).toBe("This screenshot was already imported.");
    expect(world.extractor.requests).toHaveLength(1);
  });

  it("does not offer chat Confirm for a draft with a possible duplicate, and sends people to the app", async () => {
    await world.photo(ALEX, { seed: 1 });
    await world.tap(ALEX, world.draftMessage(ALEX), "Confirm");
    await world.photo(ALEX, { seed: 2 });
    const second = fake.messagesTo(alexChat).at(-1);
    expect(second?.text).toContain("may repeat");
    expect(fake.hasButton(second!, "Confirm")).toBe(false);
    expect(second?.text).toContain("Open in app to review before adding");
  });

  it("keeps long drafts within Telegram's 4096 character cap", async () => {
    const { extraction, transaction } = await import("@/test-support/extraction");
    const rows = Array.from({ length: 60 }, (_, i) =>
      transaction({
        merchant: `${"Very long merchant name ".repeat(20)}${String(i)}`,
        amount_value: String(10 + i),
        amount_text: `€${String(10 + i)},00`,
      }),
    );
    world.extractor.enqueue({ ok: true, model: "claude-haiku-5-5", extraction: extraction(rows) });
    await world.photo(ALEX);
    const draft = world.draftMessage(ALEX);
    expect(draft.text.length).toBeLessThanOrEqual(4096);
    await world.tap(ALEX, draft, "Edit rows");
    expect(draft.text.length).toBeLessThanOrEqual(4096);
  });

  it("discards a draft on Cancel and adds nothing", async () => {
    await world.photo(ALEX);
    const draft = world.draftMessage(ALEX);
    await world.tap(ALEX, draft, "Cancel");
    expect(draft.text).toContain("Discarded");
    expect(await ledger()).toHaveLength(0);
    const [row] = await db.select().from(s.imports);
    expect(row?.status).toBe("cancelled");
  });

  it("changes the payer, the category, the split mode and the percentages from the row editor", async () => {
    await world.photo(ALEX);
    const draft = world.draftMessage(ALEX);
    await world.tap(ALEX, draft, "Edit rows");
    await world.tap(ALEX, draft, "Shopping");
    await world.tap(ALEX, draft, "Percent");
    expect(draft.text).toContain("Shared by percent: Mei 33.34%, Mum 33.33%, Dad 33.33%");
    await world.tap(ALEX, draft, "Mei +5%");
    expect(draft.text).toContain("Mei 38.34%, Mum 33.33%, Dad 28.33%");
    // Typed percentages in reply to the editor message.
    await world.say(ALEX, "50 30", { replyTo: draft.messageId });
    expect(draft.text).toContain("Mei 50%, Mum 30%, Dad 20%");
    expect(fake.lastTo(alexChat).text).toBe("Set to Mei 50%, Mum 30%, Dad 20%.");
    await world.say(ALEX, "70 70", { replyTo: draft.messageId });
    expect(fake.lastTo(alexChat).text).toBe("The percentages must add up to 100.");
    // Paid by Mum as well: the payer button is the one with the payer marker, not the member toggle.
    await world.tap(ALEX, draft, "· Mum");
    expect(fake.hasButton(draft, "💳 Mum")).toBe(true);
    const [saved] = await db.select({ draft: s.imports.draft }).from(s.imports);
    expect((saved?.draft as { payerIds: string[] }).payerIds).toEqual(
      expect.arrayContaining([world.userIds[ALEX], world.userIds[2]]),
    );
    expect((saved?.draft as { payerIds: string[] }).payerIds).toHaveLength(2);
    const [row] = await db.select().from(s.importRows).where(eq(s.importRows.position, 0));
    expect(row?.category).toBe("shopping");
    expect(row?.draftSplit).toMatchObject({ mode: "percent" });
  });
});

describe("a screenshot posted in the group", () => {
  it("is read when the caption is a command, with the draft sent privately", async () => {
    await world.photo(MEI, { group: true, caption: "/split" });
    const note = fake.messagesTo(GROUP_CHAT);
    expect(note).toHaveLength(1);
    expect(note[0]?.text).toContain("draft is ready in their private chat");
    expect(note[0]?.text).not.toContain("Trattoria");
    const draft = fake.lastTo(PEOPLE[MEI].telegramId);
    expect(draft.text).toContain("Draft from your screenshot");
    expect(draft.text).toContain("Paid by Mei");
  });

  it("is read when the caption mentions the bot", async () => {
    await world.photo(MEI, { group: true, caption: "dinner @lullet_test_bot" });
    expect(fake.messagesTo(PEOPLE[MEI].telegramId)).toHaveLength(1);
  });

  it("is ignored without a trigger, or when the command is for another bot", async () => {
    await world.photo(MEI, { group: true });
    await world.photo(MEI, { group: true, caption: "lunch" });
    await world.photo(MEI, { group: true, caption: "/split@some_other_bot" });
    expect(fake.calls.filter((c) => c.method !== "getMe")).toHaveLength(0);
  });

  it("tells the sender to start the bot when it cannot message them privately", async () => {
    fake.blockedChats.add(PEOPLE[MEI].telegramId);
    await world.photo(MEI, { group: true, caption: "/split" });
    expect(fake.messagesTo(GROUP_CHAT)[0]?.text).toContain("Open a chat with me, press Start");
    expect(world.extractor.requests).toHaveLength(0);
  });
});

describe("who the bot answers", () => {
  it("ignores unknown users, other chats and bots without a single call or record", async () => {
    const stranger = { fromId: 555, chatId: 555, chatType: "private" as const };
    await world.send(
      (await import("@/test-support/telegram-updates")).textUpdate(stranger, "/help"),
    );
    await world.send(
      (await import("@/test-support/telegram-updates")).photoUpdate(stranger, { fileId: "x" }),
    );
    const otherGroup = {
      fromId: PEOPLE[ALEX].telegramId,
      chatId: -42,
      chatType: "supergroup" as const,
    };
    await world.send(
      (await import("@/test-support/telegram-updates")).textUpdate(otherGroup, "/help"),
    );
    await world.send(
      (await import("@/test-support/telegram-updates")).photoUpdate(otherGroup, {
        fileId: "x",
        caption: "/split",
      }),
    );
    await world.send(
      callbackUpdate(stranger, { messageId: 1, data: "c:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAA" }),
    );
    expect(fake.calls.filter((c) => c.method !== "getMe")).toHaveLength(0);
    expect(await db.select().from(s.imports)).toHaveLength(0);
    expect(await db.select().from(s.telegramUpdates)).toHaveLength(0);
  });

  it("handles a redelivered update only once", async () => {
    const { textUpdate } = await import("@/test-support/telegram-updates");
    const update = textUpdate(world.where(ALEX), "/help", { updateId: 424242 });
    expect(await world.send(update)).toMatchObject({ handled: true });
    expect(await world.send(update)).toEqual({ handled: false, reason: "duplicate" });
    expect(fake.callsTo("sendMessage")).toHaveLength(1);
  });
});

describe("commands", () => {
  it("/rate sets today's default rate for the group and audits it", async () => {
    await world.say(ALEX, "/rate EUR 1.51");
    expect(fake.lastTo(alexChat).text).toBe("Default rate for 2026-11-08 set: 1 EUR = 1.51 SGD.");
    const [rate] = await db.select().from(s.dailyRates).where(eq(s.dailyRates.base, "EUR"));
    expect(rate).toMatchObject({ rateDate: "2026-11-08", quote: "SGD", groupId: world.groupId });
    expect(Number(rate?.rate)).toBe(1.51);
    await world.say(MEI, "/rate eur 1.55", { group: true });
    expect(Number((await db.select().from(s.dailyRates))[0]?.rate)).toBe(1.55);
    expect(fake.lastTo(GROUP_CHAT).text).toContain("1 EUR = 1.55 SGD");
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "daily_rate.set"));
    expect(audit).toHaveLength(2);
  });

  it("/rate explains bad input without changing anything", async () => {
    for (const bad of [
      "/rate",
      "/rate EUR",
      "/rate EUR abc",
      "/rate SGD 1",
      "/rate ZZZ 2",
      "/rate EUR 0",
    ]) {
      await world.say(ALEX, bad);
    }
    expect(await db.select().from(s.dailyRates)).toHaveLength(0);
    expect(fake.messagesTo(alexChat)).toHaveLength(6);
  });

  it("/login sends a one-time link privately, even when asked for in the group", async () => {
    await world.say(DAD, "/login", { group: true });
    const dm = fake.lastTo(PEOPLE[DAD].telegramId);
    const link = dm.keyboard.flat()[0]?.url ?? "";
    expect(link).toMatch(/^https:\/\/lullet\.test\/signin\/link\/[A-Za-z0-9_-]{40,}$/);
    expect(fake.messagesTo(GROUP_CHAT)[0]?.text).toBe(
      "I sent you a private message with your login link.",
    );
    expect(fake.messagesTo(GROUP_CHAT)[0]?.text).not.toContain(link);
    const tokens = await db.select().from(s.loginTokens);
    expect(tokens).toHaveLength(1);
  });

  it("/login in the group says how to start the bot when private messages are not possible", async () => {
    fake.blockedChats.add(PEOPLE[DAD].telegramId);
    await world.say(DAD, "/login", { group: true });
    expect(fake.lastTo(GROUP_CHAT).text).toContain("press Start");
  });

  it("/help, /start and unknown commands answer in private; unknown commands are silent in the group", async () => {
    await world.say(ALEX, "/help");
    await world.say(ALEX, "/start");
    await world.say(ALEX, "/nonsense");
    expect(fake.messagesTo(alexChat).every((m) => m.text.includes("/rate EUR 1.51"))).toBe(true);
    expect(fake.messagesTo(alexChat)).toHaveLength(3);
    await world.say(ALEX, "/nonsense", { group: true });
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(0);
  });

  it("/alias adds another name that captions understand", async () => {
    await world.say(ALEX, "/alias mum mom");
    expect(fake.lastTo(alexChat).text).toContain('captions can now call Mum "mom"');
    await world.say(ALEX, "/alias dad mom");
    expect(fake.lastTo(alexChat).text).toBe("That name is already in use.");
    await world.photo(ALEX, { caption: "split between mom and dad" });
    expect(world.draftMessage(ALEX).text).toContain("Trattoria Roma, €48.50, Food, Mum, Dad");
  });
});

describe("telling people about ledger changes", () => {
  it("posts manual expenses to the group and DMs members affected by an edit or delete", async () => {
    const store = storeFor(db, { groupId: world.groupId, userIds: world.userIds }, { as: 1 });
    const input = {
      description: "Gelato",
      category: "food" as const,
      spentOn: "2026-11-08",
      amountMinor: 900,
      currency: "EUR",
      billed: null,
      rate: null,
      splitMethod: "equal" as const,
      payers: [{ userId: world.userIds[MEI] ?? "", amountMinor: 900 }],
      shares: [
        { userId: world.userIds[MEI] ?? "", amountMinor: 300, weight: null },
        { userId: world.userIds[MUM] ?? "", amountMinor: 300, weight: null },
        { userId: world.userIds[DAD] ?? "", amountMinor: 300, weight: null },
      ],
    };
    const created = await store.createExpense(input as never);
    const { notifier } = world.deps;
    await notifier.expenseAdded(world.groupId, world.userIds[MEI] ?? "", created);
    expect(fake.lastTo(GROUP_CHAT).text).toBe("<b>Mei</b> added Gelato, €9.00 (paid by Mei).");

    const updated = await store.updateExpense(
      created.id,
      {
        ...input,
        amountMinor: 1200,
        payers: [{ userId: world.userIds[MEI] ?? "", amountMinor: 1200 }],
        shares: input.shares.map((x) => ({ ...x, amountMinor: 400 })),
      } as never,
      created.updatedAt,
    );
    await notifier.expenseEdited(world.groupId, world.userIds[MEI] ?? "", created, updated);
    expect(fake.lastTo(PEOPLE[MUM].telegramId).text).toContain("€9.00 is now €12.00");
    expect(fake.messagesTo(PEOPLE[MEI].telegramId)).toHaveLength(0);
    expect(fake.messagesTo(PEOPLE[ALEX].telegramId)).toHaveLength(0);

    await notifier.expenseDeleted(world.groupId, world.userIds[MEI] ?? "", updated);
    expect(fake.lastTo(PEOPLE[DAD].telegramId).text).toContain("deleted Gelato");
  });

  it("never fails the change when Telegram cannot deliver", async () => {
    for (const p of PEOPLE) fake.blockedChats.add(p.telegramId);
    fake.blockedChats.add(GROUP_CHAT);
    await expect(
      world.deps.notifier.importConfirmed(world.groupId, world.userIds[ALEX] ?? "", [
        {
          id: "x",
          description: "A",
          amountMinor: 100,
          currency: "EUR",
          spentOn: "2026-11-08",
        } as never,
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("pairing a tapped button with its draft in the database", () => {
  it("remembers which message shows the draft and what it shows", async () => {
    await world.photo(ALEX);
    const draft = world.draftMessage(ALEX);
    await world.tap(ALEX, draft, "Edit rows");
    const [tracked] = await db
      .select()
      .from(s.telegramDrafts)
      .where(
        and(eq(s.telegramDrafts.chatId, alexChat), eq(s.telegramDrafts.messageId, draft.messageId)),
      );
    expect(tracked?.view).toBe("row:0");
  });
});
