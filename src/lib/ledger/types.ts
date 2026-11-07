import type { CategoryId } from "./categories";
import type { SplitMode } from "./expense-form";

/** An expense as stored, with its payers and shares. Money is integer minor units. */
export interface StoredExpense {
  readonly id: string;
  /** The screenshot import that created it, if any. */
  readonly importId?: string | null;
  readonly description: string;
  readonly category: CategoryId;
  readonly spentOn: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly billedAmountMinor: number | null;
  readonly billedCurrency: string | null;
  /** SGD per 1 unit of `rateCurrency`, as exact decimal text. */
  readonly rate: string | null;
  readonly rateCurrency: string | null;
  readonly splitMethod: SplitMode;
  readonly payers: readonly { userId: string; amountMinor: number }[];
  readonly shares: readonly { userId: string; amountMinor: number; weight: number | null }[];
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

export interface StoredSettlement {
  readonly id: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly billedAmountMinor: number | null;
  readonly billedCurrency: string | null;
  readonly rate: string | null;
  readonly rateCurrency: string | null;
  readonly settledOn: string;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

export interface Member {
  readonly userId: string;
  readonly displayName: string;
  /** The fixed member order (0..n-1) that decides who gets a spare cent. */
  readonly position: number;
}
