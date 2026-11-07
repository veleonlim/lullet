/**
 * Fixed identifiers for the local development and end to end test group, so the
 * seed script and the tests agree on who is who. Each member is linked to a made-up
 * Telegram account, so they can sign in through the real login-link flow
 * (`pnpm auth:mint-link <telegram id>`). These ids only ever exist in databases
 * created by `pnpm db:seed` or the end to end suite.
 */
export const SEED_GROUP_ID = "5eed0000-0000-4000-8000-000000000001";

/** The four members in their fixed group order (position 0 to 3); the first is the owner. */
export const SEED_MEMBERS = [
  { id: "5eed0000-0000-4000-8000-0000000000a1", displayName: "Alex", telegramUserId: 5_100_001 },
  { id: "5eed0000-0000-4000-8000-0000000000a2", displayName: "Jamie", telegramUserId: 5_100_002 },
  { id: "5eed0000-0000-4000-8000-0000000000a3", displayName: "Mum", telegramUserId: 5_100_003 },
  { id: "5eed0000-0000-4000-8000-0000000000a4", displayName: "Dad", telegramUserId: 5_100_004 },
] as const;
