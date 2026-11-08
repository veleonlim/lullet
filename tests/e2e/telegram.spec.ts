import { type APIRequestContext, type Page } from "@playwright/test";
import type { Update } from "grammy/types";
import { SEED_MEMBERS } from "@/db/seed-ids";
import type { Extraction } from "@/lib/import/extraction";
import { extraction, transaction, wireframeExtraction } from "@/test-support/extraction";
import { FakeTelegram, type FakeMessage } from "@/test-support/fake-telegram";
import {
  callbackUpdate,
  photoUpdate,
  textUpdate,
  type Where,
} from "@/test-support/telegram-updates";
import { expect, ledgerTest as test } from "./fixtures";
import { signedInitData, TEST_BOT_TOKEN } from "./support/auth";
import { resetLedgerData } from "./support/database";
import { addExpense } from "./support/ledger-page";
import { resetStubs, screenshot, stubRead } from "./support/imports";

/**
 * The Telegram bot, driven end to end the way Telegram would: simulated updates are POSTed to the
 * real webhook route of the running app, and everything the bot says back is recorded by a fake
 * Bot API server run by this test. No real bot, token or network is involved.
 */

const [alex, jamie, mum, dad] = SEED_MEMBERS;
const GROUP_CHAT = Number(process.env.E2E_TELEGRAM_GROUP_CHAT_ID);
const SECRET = process.env.E2E_TELEGRAM_WEBHOOK_SECRET ?? "";
const fake = new FakeTelegram(TEST_BOT_TOKEN);

const dm = (member: { telegramUserId: number; displayName: string }): Where => ({
  fromId: member.telegramUserId,
  chatId: member.telegramUserId,
  chatType: "private",
  firstName: member.displayName,
});

test.beforeAll(async () => {
  await fake.start(Number(process.env.E2E_FAKE_TELEGRAM_PORT));
});
test.afterAll(async () => {
  await fake.stop();
});
test.beforeEach(async () => {
  await resetLedgerData();
  await resetStubs();
  fake.reset();
});

async function deliver(request: APIRequestContext, update: Update, secret = SECRET) {
  return request.post("/api/telegram/webhook", {
    data: update,
    headers: { "x-telegram-bot-api-secret-token": secret },
  });
}

/** The newest message in a chat, once `ready` says it is the one expected. */
async function settled(
  chatId: number,
  ready: (message: FakeMessage) => boolean,
): Promise<FakeMessage> {
  await expect
    .poll(
      () => {
        const message = fake.messagesTo(chatId).at(-1);
        return message !== undefined && ready(message);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return fake.lastTo(chatId);
}

async function tap(
  request: APIRequestContext,
  who: Where,
  message: FakeMessage,
  label: string,
): Promise<void> {
  const response = await deliver(
    request,
    callbackUpdate(who, { messageId: message.messageId, data: fake.callbackFor(message, label) }),
  );
  expect(response.status()).toBe(200);
}

async function sendPhoto(
  request: APIRequestContext,
  seed: number,
  caption?: string,
  read: Extraction = wireframeExtraction(),
) {
  const image = screenshot(seed);
  await stubRead(image, read);
  fake.addFile(`file-${String(seed)}`, image.buffer);
  const response = await deliver(
    request,
    photoUpdate(dm(alex), { fileId: `file-${String(seed)}`, ...(caption ? { caption } : {}) }),
  );
  expect(response.status()).toBe(200);
  return settled(alex.telegramUserId, (m) => m.text.includes("Draft from your screenshot"));
}

async function expenseCount(page: Page): Promise<string> {
  await page.goto("/expenses");
  return (
    await page
      .getByText(/^\d+ expenses?$|^No expenses yet$/)
      .first()
      .innerText()
  ).trim();
}

test.describe("Telegram bot", () => {
  test("photo, draft, edit a row, confirm, announce to the group, undo", async ({
    page,
    request,
  }) => {
    const draft = await sendPhoto(request, 1);
    // The upload was acknowledged first, then the same message became the draft.
    expect(fake.callsTo("sendMessage")[0]?.params.text).toBe("Reading your screenshot...");
    expect(draft.text).toContain("Trattoria Roma, €48.50, Food");
    expect(draft.text).toContain("Paid by Alex");
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(0);
    expect(await expenseCount(page)).toBe("0 expenses");

    // Edit rows: go to the Louvre (row 4) and take Jamie off it.
    await tap(request, dm(alex), draft, "Edit rows");
    await settled(alex.telegramUserId, (m) => m.text.includes("Row 1 of 4"));
    for (const row of [2, 3, 4]) {
      await tap(request, dm(alex), fake.lastTo(alex.telegramUserId), "Next");
      await settled(alex.telegramUserId, (m) => m.text.includes(`Row ${String(row)} of 4`));
    }
    await tap(request, dm(alex), fake.lastTo(alex.telegramUserId), "Jamie");
    await settled(alex.telegramUserId, (m) => m.text.includes("Shared equally between Mum, Dad"));
    await tap(request, dm(alex), fake.lastTo(alex.telegramUserId), "Summary");
    const summary = await settled(alex.telegramUserId, (m) =>
      m.text.includes("Louvre, €64.00, Sightseeing, Mum, Dad"),
    );

    await tap(request, dm(alex), summary, "Confirm 4");
    const added = await settled(alex.telegramUserId, (m) => m.text.includes("Added 4 expenses"));
    expect(fake.hasButton(added, "Undo")).toBe(true);
    expect(await expenseCount(page)).toBe("4 expenses");

    const announcement = await settled(GROUP_CHAT, (m) =>
      m.text.includes("4 expenses from a screenshot"),
    );
    expect(announcement.text).toContain("Alex");
    expect(announcement.text).toContain("€148.49");

    await tap(request, dm(alex), added, "Undo");
    await settled(alex.telegramUserId, (m) => m.text.startsWith("Undone."));
    expect(await expenseCount(page)).toBe("0 expenses");
    for (const other of [jamie, mum, dad]) {
      await settled(other.telegramUserId, (m) => m.text.includes("undid an import"));
    }
  });

  test("Confirm is idempotent, and only the uploader can use it", async ({ page, request }) => {
    const draft = await sendPhoto(request, 2);
    const data = fake.callbackFor(draft, "Confirm");

    // Jamie holds Alex's button (for example a forwarded message) and taps it.
    await deliver(
      request,
      callbackUpdate(dm(jamie), { messageId: 4242, data, queryId: "jamie-tap" }),
    );
    await expect.poll(() => fake.answers.find((a) => a.id === "jamie-tap")?.alert).toBe(true);
    expect(fake.answers.find((a) => a.id === "jamie-tap")?.text).toBe(
      "Only Alex can do that with this import.",
    );
    expect(await expenseCount(page)).toBe("0 expenses");
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(0);

    // Alex taps twice: one set of expenses, one announcement.
    for (const id of ["a1", "a2"]) {
      await deliver(
        request,
        callbackUpdate(dm(alex), { messageId: draft.messageId, data, queryId: id }),
      );
    }
    await expect
      .poll(() => fake.answers.map((a) => a.id))
      .toEqual(expect.arrayContaining(["a1", "a2"]));
    // Both taps are handled after their responses, so either may finish first: one adds, one is told so.
    expect(["a1", "a2"].map((id) => fake.answers.find((a) => a.id === id)?.text).sort()).toEqual([
      "Added 4",
      "Already added",
    ]);
    expect(await expenseCount(page)).toBe("4 expenses");
    expect(fake.messagesTo(GROUP_CHAT)).toHaveLength(1);
  });

  test("ignores unknown people and other chats completely", async ({ request }) => {
    const stranger: Where = { fromId: 777, chatId: 777, chatType: "private" };
    const otherGroup: Where = { fromId: alex.telegramUserId, chatId: -42, chatType: "supergroup" };
    fake.addFile("x", screenshot(3).buffer);
    for (const update of [
      textUpdate(stranger, "/help"),
      photoUpdate(stranger, { fileId: "x" }),
      textUpdate(otherGroup, "/help"),
      photoUpdate(otherGroup, { fileId: "x", caption: "/split" }),
      callbackUpdate(stranger, { messageId: 1, data: "c:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAA" }),
    ]) {
      // Telegram is always answered 200, so a stranger cannot tell the bot from a dead URL.
      expect((await deliver(request, update)).status()).toBe(200);
    }
    // A real member's message right after is answered, so the ignored ones had their chance first.
    await deliver(request, textUpdate(dm(alex), "/help"));
    await settled(alex.telegramUserId, (m) => m.text.includes("/rate EUR 1.51"));
    const sent = fake.calls.filter((c) => c.method !== "getMe");
    expect(sent.map((c) => c.params.chat_id)).toEqual([alex.telegramUserId]);
  });

  test("refuses webhook calls without the secret token", async ({ request }) => {
    expect(
      (await deliver(request, textUpdate(dm(alex), "/help"), "wrong-secret-0123456789")).status(),
    ).toBe(401);
    const bare = await request.post("/api/telegram/webhook", {
      data: textUpdate(dm(alex), "/help"),
    });
    expect(bare.status()).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  test("a caption chooses who shares, and a group photo gets its draft privately", async ({
    request,
  }) => {
    const draft = await sendPhoto(request, 4, "split between jamie and dad");
    expect(draft.text).toContain("Trattoria Roma, €48.50, Food, Jamie, Dad");

    const image = screenshot(5);
    await stubRead(image, wireframeExtraction());
    fake.addFile("group-photo", image.buffer);
    await deliver(
      request,
      photoUpdate(
        { fromId: jamie.telegramUserId, chatId: GROUP_CHAT, chatType: "supergroup" },
        { fileId: "group-photo", caption: "/split" },
      ),
    );
    await settled(jamie.telegramUserId, (m) => m.text.includes("Draft from your screenshot"));
    expect(fake.messagesTo(GROUP_CHAT).every((m) => !m.text.includes("Trattoria"))).toBe(true);
  });

  test("/rate sets today's default rate", async ({ request }) => {
    await deliver(request, textUpdate(dm(alex), "/rate EUR 1.51"));
    const reply = await settled(alex.telegramUserId, (m) =>
      m.text.includes("set: 1 EUR = 1.51 SGD"),
    );
    expect(reply.text).toMatch(/^Default rate for \d{4}-\d{2}-\d{2} set/);
  });

  test("/login sends a one-time link that signs the member in on the web", async ({
    browser,
    request,
  }) => {
    await deliver(request, textUpdate(dm(mum), "/login"));
    const message = await settled(mum.telegramUserId, (m) => m.keyboard.length > 0);
    const link = message.keyboard.flat()[0]?.url ?? "";
    expect(link).toMatch(/\/signin\/link\//);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(link);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("signed-in-as")).toHaveText("Mum");
    await context.close();
  });

  test("the Mini App opens the review page, signed in by Telegram's launch data", async ({
    browser,
    request,
  }) => {
    const draft = await sendPhoto(request, 6);
    const url = draft.keyboard.flat().find((b) => b.text === "Open in app")?.web_app?.url ?? "";
    expect(url).toContain("/signin?next=%2Fimports%2F");

    // A fresh browser with no cookie, like Telegram's in-app browser on first launch.
    const context = await browser.newContext();
    const mini = await context.newPage();
    await mini.goto(
      `${url}#tgWebAppData=${encodeURIComponent(signedInitData(alex.telegramUserId))}`,
    );
    await expect(mini.getByRole("heading", { level: 1, name: "Review import" })).toBeVisible();
    await expect(mini.getByTestId("signed-in-as")).toHaveText("Alex");
    await context.close();

    // Launch data signed for someone who is not on the list opens nothing.
    const stranger = await browser.newContext();
    const page = await stranger.newPage();
    await page.goto(`${url}#tgWebAppData=${encodeURIComponent(signedInitData(31337))}`);
    await expect(page.getByText("not on the list for this trip")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review import" })).toHaveCount(0);
    await stranger.close();
  });

  test("a payment billed in SGD shows what counts, and its amount is edited in the app", async ({
    browser,
    request,
  }) => {
    // A card-app screenshot: EUR 100.00 with an unlabeled 144.26 that is the SGD actually charged.
    const draft = await sendPhoto(
      request,
      8,
      undefined,
      extraction([
        transaction({
          merchant: "Trenitalia",
          amount_text: "EUR 100.00",
          amount_value: "100.00",
          billed_amount_text: "144.26",
          billed_amount_value: "144.26",
          billed_currency: "SGD",
          category: "transport",
        }),
      ]),
    );
    expect(draft.text).toContain("1. Trenitalia, S$144.26 (€100.00), Transport");
    expect(draft.text).toContain("<b>S$144.26</b>");

    // The chat editor shows the same, and leads the amount edit to this row in the app.
    await tap(request, dm(alex), draft, "Edit rows");
    const editor = await settled(alex.telegramUserId, (m) => m.text.includes("Row 1 of 1"));
    expect(editor.text).toContain("Trenitalia, S$144.26 (€100.00), Transport");
    const url = editor.keyboard.flat().find((b) => b.text === "Edit amount in app")?.web_app?.url;
    expect(url).toContain("/signin?next=%2Fimports%2F");
    expect(decodeURIComponent(url ?? "")).toMatch(/\/imports\/[0-9a-f-]{36}\?row=[0-9a-f-]{36}/);

    // The Mini App opens on that row with the amount ready to change.
    const context = await browser.newContext();
    const mini = await context.newPage();
    await mini.goto(
      `${url ?? ""}#tgWebAppData=${encodeURIComponent(signedInitData(alex.telegramUserId))}`,
    );
    const amount = mini.getByLabel("Amount", { exact: true });
    await expect(amount).toHaveValue("100.00");
    await expect(amount).toBeFocused();
    await amount.fill("120.00");
    await mini.getByLabel("Currency").selectOption("CHF");
    await mini.getByLabel("Charged to your card (optional)").fill("172.50");
    await expect(mini.getByTestId("save-state")).toHaveText("Saved");
    await context.close();

    // Back in the chat, the draft follows the correction.
    await tap(request, dm(alex), editor, "Summary");
    // (CHF amounts are written with a non-breaking space, so compare with plain spaces.)
    await settled(alex.telegramUserId, (m) =>
      m.text.replace(/\s/g, " ").includes("1. Trenitalia, S$172.50 (CHF 120.00)"),
    );
  });

  test("manual expenses are announced to the group, and edits and deletes tell the members involved", async ({
    page,
  }) => {
    await addExpense(page, {
      description: "Gelato",
      amount: "9.00",
      currency: "EUR",
      date: "2026-11-08",
    });
    const note = await settled(GROUP_CHAT, (m) => m.text.includes("Gelato"));
    expect(note.text).toBe("<b>Alex</b> added Gelato, €9.00 (paid by Alex).");

    await page.getByRole("link", { name: "Edit expense" }).click();
    await page.getByLabel("Amount", { exact: true }).fill("12.00");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("native-amount")).toHaveText("€12.00");
    const edited = await settled(jamie.telegramUserId, (m) => m.text.includes("edited"));
    expect(edited.text).toContain("€9.00 is now €12.00");
    expect(fake.messagesTo(alex.telegramUserId)).toHaveLength(0);

    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: /Delete/ })
      .first()
      .click();
    await settled(dad.telegramUserId, (m) => m.text.includes("deleted Gelato"));
  });
});
