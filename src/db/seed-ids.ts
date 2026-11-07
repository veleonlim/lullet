/**
 * Fixed identifiers for the local development and end to end test group, so the
 * seed script, the development sign-in stub and the tests all agree on who is who.
 * These ids only ever exist in databases created by `pnpm db:seed`.
 */
export const SEED_GROUP_ID = "5eed0000-0000-4000-8000-000000000001";

/** The four members in their fixed group order (position 0 to 3). */
export const SEED_MEMBERS = [
  { id: "5eed0000-0000-4000-8000-0000000000a1", displayName: "Alex" },
  { id: "5eed0000-0000-4000-8000-0000000000a2", displayName: "Jamie" },
  { id: "5eed0000-0000-4000-8000-0000000000a3", displayName: "Mum" },
  { id: "5eed0000-0000-4000-8000-0000000000a4", displayName: "Dad" },
] as const;
