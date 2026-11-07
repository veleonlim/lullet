import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { signInWithInitData, signInWithLoginToken } from "@/lib/auth/db/login";
import { mintLoginLink, peekLoginToken, redeemLoginToken } from "@/lib/auth/db/login-links";
import {
  bootstrapGroup,
  findMemberByTelegramId,
  getCurrentUser,
  listMembers,
  rebindMember,
} from "@/lib/auth/db/members";
import { createSession, deleteSession, resolveSession } from "@/lib/auth/db/sessions";
import { hashToken } from "@/lib/auth/tokens";
import { buildInitData, TEST_BOT_TOKEN } from "@/test-support/telegram";
import {
  closeTestDb,
  expectPgError,
  PG,
  resetDatabase,
  seedAllowlistedGroup,
  seedGroup,
  TEST_SECRET,
  testDb,
  type AuthSeed,
} from "./helpers";

const T0 = new Date("2026-11-07T12:00:00Z");
const after = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let seed: AuthSeed;
const deps = (now: Date = T0) => ({ db: testDb(), secret: TEST_SECRET, now });
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

beforeEach(async () => {
  await resetDatabase(testDb());
  seed = await seedAllowlistedGroup(testDb());
});
afterAll(closeTestDb);

describe("allowlist", () => {
  it("serves linked Telegram users and nobody else", async () => {
    expect(await findMemberByTelegramId(1001, deps())).toEqual({
      userId: seed.userIds[0],
      groupId: seed.groupId,
    });
    expect(await findMemberByTelegramId(9999, deps())).toBeNull();
    expect(await findMemberByTelegramId(0, deps())).toBeNull();
    expect(await findMemberByTelegramId(-1, deps())).toBeNull();
    expect(await findMemberByTelegramId(1.5, deps())).toBeNull();
  });

  it("gives no session to a member who has no Telegram link", async () => {
    const other = await seedGroup(testDb(), 1);
    const minted = await createSession(
      { userId: other.userIds[0] ?? "", groupId: other.groupId },
      {},
      deps(),
    );
    expect(await resolveSession(minted.token, deps())).toBeNull();
  });

  it("makes the first member the owner and orders members", async () => {
    const members = await listMembers(seed.groupId, deps());
    expect(members.map((m) => [m.displayName, m.isOwner, m.telegramUserId])).toEqual([
      ["Member 1", true, 1001],
      ["Member 2", false, 1002],
      ["Member 3", false, 1003],
      ["Member 4", false, 1004],
    ]);
  });

  it("allows only one owner per group and one Telegram account per member", async () => {
    await expectPgError(
      testDb()
        .update(s.memberships)
        .set({ isOwner: true })
        .where(eq(s.memberships.userId, seed.userIds[1] ?? "")),
      { code: PG.uniqueViolation, constraint: "memberships_one_owner_per_group_idx" },
    );
    await expectPgError(
      testDb()
        .update(s.telegramLinks)
        .set({ telegramUserId: 1001 })
        .where(eq(s.telegramLinks.telegramUserId, 1002)),
      { code: PG.uniqueViolation },
    );
  });

  it("rejects a bootstrap with an invalid Telegram id or no members", async () => {
    await expect(
      bootstrapGroup(
        { groupName: "x", members: [{ displayName: "A", telegramUserId: 0 }] },
        deps(),
      ),
    ).rejects.toThrow(/Invalid Telegram user id/);
    await expect(bootstrapGroup({ groupName: "x", members: [] }, deps())).rejects.toThrow(
      /at least one member/,
    );
  });

  it("rolls the whole bootstrap back when one member cannot be linked", async () => {
    await expect(
      bootstrapGroup(
        {
          groupName: "Doomed",
          members: [
            { displayName: "A", telegramUserId: 5001 },
            { displayName: "B", telegramUserId: 1001 }, // already taken
          ],
        },
        deps(),
      ),
    ).rejects.toThrow();
    const groups = await testDb().select().from(s.groups).where(eq(s.groups.name, "Doomed"));
    expect(groups).toEqual([]);
    expect(await findMemberByTelegramId(5001, deps())).toBeNull();
  });
});

describe("sessions", () => {
  const member = () => ({ userId: seed.userIds[0] ?? "", groupId: seed.groupId });

  it("stores only a hash of the cookie value", async () => {
    const { token } = await createSession(member(), {}, deps());
    const rows = await testDb().select().from(s.sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(TEST_SECRET, token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("resolves a live session to the member and group", async () => {
    const { token } = await createSession(member(), {}, deps());
    expect(await resolveSession(token, deps())).toMatchObject(member());
    expect(await resolveSession("not-a-session", deps())).toBeNull();
    expect(await resolveSession(token, { ...deps(), secret: `${TEST_SECRET}-other` })).toBeNull();
  });

  it("expires after 30 days", async () => {
    const { token, expiresAt } = await createSession(member(), {}, deps());
    expect(expiresAt).toEqual(after(30 * 24 * 3600));
    expect(await resolveSession(token, deps(after(30 * 24 * 3600 - 1)))).not.toBeNull();
    expect(await resolveSession(token, deps(after(30 * 24 * 3600)))).toBeNull();
  });

  it("logout deletes the session on the server, so a copied cookie stops working", async () => {
    const { token } = await createSession(member(), {}, deps());
    await deleteSession(token, deps());
    expect(await resolveSession(token, deps())).toBeNull();
    expect(await testDb().select().from(s.sessions)).toEqual([]);
  });

  it("rotates on login: the previous cookie is destroyed and the new one differs", async () => {
    const first = await createSession(member(), {}, deps());
    const second = await createSession(member(), { replacing: first.token }, deps());
    expect(second.token).not.toBe(first.token);
    expect(await resolveSession(first.token, deps())).toBeNull();
    expect(await resolveSession(second.token, deps())).not.toBeNull();
    expect(await testDb().select().from(s.sessions)).toHaveLength(1);
  });

  it("does not let a login replace somebody else's session by guessing a token", async () => {
    const mine = await createSession(member(), {}, deps());
    const other = { userId: seed.userIds[1] ?? "", groupId: seed.groupId };
    await createSession(other, { replacing: "guess" }, deps());
    expect(await resolveSession(mine.token, deps())).not.toBeNull();
  });

  it("sweeps expired sessions and login links when a new session starts", async () => {
    const old = await createSession(member(), {}, deps());
    await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps());
    await createSession(member(), {}, deps(after(31 * 24 * 3600)));
    const remaining = await testDb().select().from(s.sessions);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tokenHash).not.toBe(hashToken(TEST_SECRET, old.token));
    expect(await testDb().select().from(s.loginTokens)).toEqual([]);
  });

  it("ends when the member leaves the group", async () => {
    const { token } = await createSession(member(), {}, deps());
    await testDb()
      .delete(s.memberships)
      .where(eq(s.memberships.userId, seed.userIds[0] ?? ""));
    expect(await resolveSession(token, deps())).toBeNull();
  });

  it("ends when the member is removed from the allowlist", async () => {
    const { token } = await createSession(member(), {}, deps());
    await testDb()
      .delete(s.telegramLinks)
      .where(eq(s.telegramLinks.userId, seed.userIds[0] ?? ""));
    expect(await resolveSession(token, deps())).toBeNull();
  });

  it("looks up the current user's name and role", async () => {
    expect(await getCurrentUser(member(), deps())).toEqual({
      ...member(),
      displayName: "Member 1",
      isOwner: true,
    });
    expect(
      await getCurrentUser({ userId: seed.userIds[1] ?? "", groupId: seed.groupId }, deps()),
    ).toMatchObject({ displayName: "Member 2", isOwner: false });
    expect(
      await getCurrentUser({ userId: crypto.randomUUID(), groupId: seed.groupId }, deps()),
    ).toBeNull();
  });
});

describe("login links", () => {
  it("mints a link only for allowlisted Telegram users", async () => {
    expect(await mintLoginLink(424242, { baseUrl: "https://x.test" }, deps())).toBeNull();
    expect(await testDb().select().from(s.loginTokens)).toEqual([]);

    const link = await mintLoginLink(1002, { baseUrl: "https://lullet.test" }, deps());
    expect(link?.url).toMatch(/^https:\/\/lullet\.test\/signin\/link\/[A-Za-z0-9_-]{43}$/);
    expect(link?.expiresAt).toEqual(after(600));
  });

  it("stores the token hashed", async () => {
    const link = await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps());
    const token = tokenOf(link?.url ?? "");
    const rows = await testDb().select().from(s.loginTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(TEST_SECRET, token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("signs the right member in, and only once (replay is refused)", async () => {
    const token = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    const first = await signInWithLoginToken(token, {}, deps(after(5)));
    expect(first.ok && first.member).toEqual({ userId: seed.userIds[1], groupId: seed.groupId });
    expect(await signInWithLoginToken(token, {}, deps(after(6)))).toEqual({
      ok: false,
      reason: "invalid_link",
    });
    // Replay did not create a second session.
    expect(await testDb().select().from(s.sessions)).toHaveLength(1);
  });

  it("only one of many concurrent redemptions succeeds", async () => {
    const token = tokenOf(
      (await mintLoginLink(1003, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, () => redeemLoginToken(token, deps(after(1)))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const [row] = await testDb().select().from(s.loginTokens);
    expect(row?.consumedAt).toEqual(after(1));
  });

  it("expires after ten minutes", async () => {
    const token = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    expect(await peekLoginToken(token, deps(after(599)))).toEqual({ displayName: "Member 2" });
    expect(await peekLoginToken(token, deps(after(600)))).toBeNull();
    expect(await signInWithLoginToken(token, {}, deps(after(600)))).toEqual({
      ok: false,
      reason: "invalid_link",
    });
    expect(await testDb().select().from(s.sessions)).toEqual([]);
  });

  it("honours a custom lifetime", async () => {
    const link = await mintLoginLink(1002, { baseUrl: "https://x.test", ttlSeconds: 30 }, deps());
    expect(link?.expiresAt).toEqual(after(30));
  });

  it("peeking does not use the link up", async () => {
    const token = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    for (let i = 0; i < 3; i += 1) expect(await peekLoginToken(token, deps())).not.toBeNull();
    expect((await signInWithLoginToken(token, {}, deps())).ok).toBe(true);
    expect(await peekLoginToken(token, deps())).toBeNull();
  });

  it("refuses unknown tokens and tokens hashed under another secret", async () => {
    const token = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    expect(await redeemLoginToken("nope", deps())).toBeNull();
    expect(await redeemLoginToken(token, { ...deps(), secret: `${TEST_SECRET}-other` })).toBeNull();
  });

  it("withdraws a member's older unused link when a new one is minted", async () => {
    const old = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    const fresh = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    expect(await peekLoginToken(old, deps())).toBeNull();
    expect(await peekLoginToken(fresh, deps())).not.toBeNull();
    // Another member's link is untouched.
    const other = tokenOf(
      (await mintLoginLink(1003, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps());
    expect(await peekLoginToken(other, deps())).not.toBeNull();
  });

  it("refuses a link whose member has since been taken off the allowlist", async () => {
    const token = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    await testDb().delete(s.telegramLinks).where(eq(s.telegramLinks.telegramUserId, 1002));
    expect(await signInWithLoginToken(token, {}, deps())).toEqual({
      ok: false,
      reason: "invalid_link",
    });
  });

  it("replaces the browser's previous session on login", async () => {
    const member = { userId: seed.userIds[1] ?? "", groupId: seed.groupId };
    const before = await createSession(member, {}, deps());
    const token = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    const result = await signInWithLoginToken(token, { replacing: before.token }, deps());
    expect(result.ok).toBe(true);
    expect(await resolveSession(before.token, deps())).toBeNull();
  });

  it("uses the configured app url when none is passed", async () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = "https://configured.test/";
    try {
      const link = await mintLoginLink(1002, {}, deps());
      expect(link?.url.startsWith("https://configured.test/signin/link/")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previous;
    }
  });
});

describe("Mini App sign in", () => {
  const initData = (userId: number, authDate = T0) => buildInitData({ userId, authDate });
  const options = { botToken: TEST_BOT_TOKEN };

  it("signs in an allowlisted Telegram user", async () => {
    const result = await signInWithInitData(initData(1004), options, deps(after(20)));
    expect(result.ok && result.member).toEqual({ userId: seed.userIds[3], groupId: seed.groupId });
    expect(result.ok && (await resolveSession(result.session.token, deps(after(20))))).toBeTruthy();
  });

  it("refuses a validly signed user who is not on the allowlist, and creates nothing", async () => {
    expect(await signInWithInitData(initData(777777), options, deps(after(20)))).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(await testDb().select().from(s.sessions)).toEqual([]);
  });

  it("refuses forged, wrong-bot and stale init data", async () => {
    const forged = new URLSearchParams(initData(1001));
    forged.set("user", JSON.stringify({ id: 1001, first_name: "Forged" }));
    expect(await signInWithInitData(forged.toString(), options, deps(after(5)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const wrongBot = buildInitData({ userId: 1001, authDate: T0, botToken: "1:other" });
    expect(await signInWithInitData(wrongBot, options, deps(after(5)))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await signInWithInitData(initData(1001), options, deps(after(3601)))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      await signInWithInitData(initData(1001), { ...options, maxAgeSeconds: 10 }, deps(after(11))),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await testDb().select().from(s.sessions)).toEqual([]);
  });

  it("reads the bot token from the environment when not passed", async () => {
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
    try {
      const result = await signInWithInitData(initData(1001), {}, deps(after(1)));
      expect(result.ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previous;
    }
  });
});

describe("owner re-bind", () => {
  const owner = () => ({ userId: seed.userIds[0] ?? "", groupId: seed.groupId });
  const target = () => seed.userIds[1] ?? "";

  it("moves a member to a new Telegram account and signs out the old one", async () => {
    const victim = { userId: target(), groupId: seed.groupId };
    const oldSession = await createSession(victim, {}, deps());
    const pending = tokenOf(
      (await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps()))?.url ?? "",
    );
    await testDb()
      .update(s.telegramLinks)
      .set({ username: "oldname", privateChatId: 55 })
      .where(eq(s.telegramLinks.userId, target()));

    const result = await rebindMember(
      { actor: owner(), targetUserId: target(), telegramUserId: 2002 },
      deps(),
    );
    expect(result).toEqual({ ok: true });

    // The new account is on the allowlist; the old one is not.
    expect(await findMemberByTelegramId(2002, deps())).toEqual(victim);
    expect(await findMemberByTelegramId(1002, deps())).toBeNull();
    // Old sign-ins and unused links are gone.
    expect(await resolveSession(oldSession.token, deps())).toBeNull();
    expect(await peekLoginToken(pending, deps())).toBeNull();
    // Stale chat details of the old account are cleared.
    const [link] = await testDb()
      .select()
      .from(s.telegramLinks)
      .where(eq(s.telegramLinks.userId, target()));
    expect(link).toMatchObject({ telegramUserId: 2002, username: null, privateChatId: null });
  });

  it("writes an audit row", async () => {
    await rebindMember({ actor: owner(), targetUserId: target(), telegramUserId: 2002 }, deps());
    const [row] = await testDb()
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.action, "member.telegram_rebound"));
    expect(row).toMatchObject({
      groupId: seed.groupId,
      actorUserId: seed.userIds[0],
      entityId: target(),
      before: { telegramUserId: 1002 },
      after: { telegramUserId: 2002 },
    });
  });

  it("refuses everyone who is not the owner", async () => {
    const notOwner = { userId: seed.userIds[2] ?? "", groupId: seed.groupId };
    expect(
      await rebindMember({ actor: notOwner, targetUserId: target(), telegramUserId: 2002 }, deps()),
    ).toEqual({ ok: false, reason: "not_owner" });
    expect(await findMemberByTelegramId(1002, deps())).not.toBeNull();
    expect(await findMemberByTelegramId(2002, deps())).toBeNull();
  });

  it("refuses an owner of a different group and strangers", async () => {
    const otherGroup = await bootstrapGroup(
      { groupName: "Other", members: [{ displayName: "Boss", telegramUserId: 8001 }] },
      deps(),
    );
    const foreignOwner = { userId: otherGroup.userIds[0] ?? "", groupId: otherGroup.groupId };
    // Their own group has no such member.
    expect(
      await rebindMember(
        { actor: foreignOwner, targetUserId: target(), telegramUserId: 2002 },
        deps(),
      ),
    ).toEqual({ ok: false, reason: "not_a_member" });
    // Claiming to act in a group they do not belong to.
    expect(
      await rebindMember(
        {
          actor: { userId: foreignOwner.userId, groupId: seed.groupId },
          targetUserId: target(),
          telegramUserId: 2002,
        },
        deps(),
      ),
    ).toEqual({ ok: false, reason: "not_owner" });
    expect(await findMemberByTelegramId(1002, deps())).not.toBeNull();
  });

  it("refuses invalid ids and ids already linked to somebody else", async () => {
    for (const bad of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        await rebindMember({ actor: owner(), targetUserId: target(), telegramUserId: bad }, deps()),
      ).toEqual({ ok: false, reason: "invalid_telegram_id" });
    }
    expect(
      await rebindMember({ actor: owner(), targetUserId: target(), telegramUserId: 1003 }, deps()),
    ).toEqual({ ok: false, reason: "telegram_id_in_use" });
    expect(await findMemberByTelegramId(1002, deps())).not.toBeNull();
  });

  it("lets the owner re-bind themselves without signing out their current session", async () => {
    const current = await createSession(owner(), {}, deps());
    const other = await createSession(owner(), {}, deps());
    const currentId = (await resolveSession(current.token, deps()))?.sessionId;
    const result = await rebindMember(
      {
        actor: owner(),
        targetUserId: owner().userId,
        telegramUserId: 3001,
        ...(currentId ? { keepSessionId: currentId } : {}),
      },
      deps(),
    );
    expect(result).toEqual({ ok: true });
    expect(await resolveSession(current.token, deps())).not.toBeNull();
    expect(await resolveSession(other.token, deps())).toBeNull();
  });

  it("does not revoke or consume anything for a refused re-bind", async () => {
    const session = await createSession({ userId: target(), groupId: seed.groupId }, {}, deps());
    const link = await mintLoginLink(1002, { baseUrl: "https://x.test" }, deps());
    await rebindMember({ actor: owner(), targetUserId: target(), telegramUserId: 1003 }, deps());
    expect(await resolveSession(session.token, deps())).not.toBeNull();
    expect(await peekLoginToken(tokenOf(link?.url ?? ""), deps())).not.toBeNull();
  });

  it("creates the link when the member had none", async () => {
    await testDb().delete(s.telegramLinks).where(eq(s.telegramLinks.userId, target()));
    expect(
      await rebindMember({ actor: owner(), targetUserId: target(), telegramUserId: 4001 }, deps()),
    ).toEqual({ ok: true });
    expect(await findMemberByTelegramId(4001, deps())).toMatchObject({ userId: target() });
  });
});
