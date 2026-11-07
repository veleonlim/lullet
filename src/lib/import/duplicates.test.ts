import { describe, expect, it } from "vitest";
import {
  findDuplicate,
  merchantsMatch,
  merchantWords,
  type DuplicateCandidate,
  type DuplicateProbe,
} from "./duplicates";

const candidate = (overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  kind: "expense",
  id: "e1",
  importId: null,
  merchant: "Trattoria Roma",
  spentOn: "2026-11-03",
  amountMinor: 4850,
  currency: "EUR",
  billedAmountMinor: null,
  billedCurrency: null,
  payerIds: ["alex"],
  ...overrides,
});

const probe = (overrides: Partial<DuplicateProbe> = {}): DuplicateProbe => ({
  merchant: "Trattoria Roma",
  spentOn: "2026-11-03",
  amountMinor: 4850,
  currency: "EUR",
  billedAmountMinor: null,
  billedCurrency: null,
  ...overrides,
});

describe("merchantsMatch", () => {
  it("ignores case, accents, punctuation and company suffixes", () => {
    expect(merchantsMatch("Trattoria Roma", "TRATTORIA ROMA SRL")).toBe(true);
    expect(merchantsMatch("Café de Flore", "Cafe de flore")).toBe(true);
    expect(merchantsMatch("McDonald's", "MCDONALDS")).toBe(true);
  });

  it("matches one name inside the other, shared words and small typos", () => {
    expect(merchantsMatch("Louvre", "Louvre Museum Paris")).toBe(true);
    expect(merchantsMatch("Hotel Lumiere Paris", "Lumiere Hotel")).toBe(true);
    expect(merchantsMatch("Trattoria Romma", "Trattoria Roma")).toBe(true);
  });

  it("does not match different places", () => {
    expect(merchantsMatch("Trattoria Roma", "Metro Roma")).toBe(false);
    expect(merchantsMatch("Louvre", "Lidl")).toBe(false);
    expect(merchantsMatch("Zara", "Zurich Airport")).toBe(false);
  });

  it("does not match when a name has nothing readable", () => {
    expect(merchantsMatch(null, "Trattoria")).toBe(false);
    expect(merchantsMatch("!!!", "Trattoria")).toBe(false);
    expect(merchantsMatch("Trattoria", "The Bar")).toBe(false);
  });

  it("lists the words a name is made of", () => {
    // Accents are folded away and noise words ("the", "cafe", "srl") are left out.
    expect(merchantWords("The Café de Flore, SRL")).toEqual(["de", "flore"]);
  });
});

describe("findDuplicate", () => {
  it("finds the same amount, currency, day and merchant", () => {
    const match = findDuplicate(probe(), [candidate()], ["alex"]);
    expect(match?.candidate.id).toBe("e1");
    expect(match?.samePayer).toBe(true);
  });

  it("allows a day either side and a different payer", () => {
    expect(findDuplicate(probe({ spentOn: "2026-11-04" }), [candidate()], ["mei"])?.samePayer).toBe(
      false,
    );
    expect(findDuplicate(probe({ spentOn: "2026-11-02" }), [candidate()], ["alex"])).not.toBeNull();
  });

  it("does not match two days apart, another amount, another currency or another merchant", () => {
    expect(findDuplicate(probe({ spentOn: "2026-11-05" }), [candidate()], [])).toBeNull();
    expect(findDuplicate(probe({ amountMinor: 4851 }), [candidate()], [])).toBeNull();
    expect(findDuplicate(probe({ currency: "CHF" }), [candidate()], [])).toBeNull();
    expect(findDuplicate(probe({ merchant: "Metro" }), [candidate()], [])).toBeNull();
  });

  it("matches on the billed figure too", () => {
    const billed = candidate({ billedAmountMinor: 7520, billedCurrency: "SGD" });
    expect(
      findDuplicate(probe({ amountMinor: 7520, currency: "SGD" }), [billed], []),
    ).not.toBeNull();
    expect(
      findDuplicate(
        probe({ billedAmountMinor: 7520, billedCurrency: "SGD", amountMinor: 1, currency: "EUR" }),
        [billed],
        [],
      ),
    ).not.toBeNull();
  });

  it("cannot match a row without a day, an amount or a merchant", () => {
    expect(findDuplicate(probe({ spentOn: null }), [candidate()], [])).toBeNull();
    expect(findDuplicate(probe({ amountMinor: null }), [candidate()], [])).toBeNull();
    expect(
      findDuplicate(probe({ currency: null, billedCurrency: null }), [candidate()], []),
    ).toBeNull();
    expect(findDuplicate(probe({ merchant: null }), [candidate()], [])).toBeNull();
  });

  it("prefers the same payer, then the same day, then the ledger over a draft", () => {
    const other = candidate({ id: "e2", payerIds: ["mei"] });
    expect(findDuplicate(probe(), [other, candidate()], ["alex"])?.candidate.id).toBe("e1");
    const sameDay = candidate({ id: "e3", spentOn: "2026-11-03" });
    const nextDay = candidate({ id: "e4", spentOn: "2026-11-04" });
    expect(findDuplicate(probe(), [nextDay, sameDay], [])?.candidate.id).toBe("e3");
    const draft = candidate({ id: "d1", kind: "draft", importId: "i1" });
    expect(findDuplicate(probe(), [draft, candidate()], [])?.candidate.kind).toBe("expense");
    expect(findDuplicate(probe(), [draft], [])?.candidate).toMatchObject({
      kind: "draft",
      importId: "i1",
    });
  });
});
