"use client";

import { useState } from "react";
import { formatBasisPoints, readBasisPoints, type Member } from "@/lib/ledger";
import { Avatar } from "../avatar";

/** One tap per person: pressed means they are in. Real buttons, so the keyboard works. */
export function MemberChips({
  label,
  members,
  selected,
  onToggle,
  disabled = false,
  size = "md",
}: {
  label: string;
  members: readonly Member[];
  selected: readonly string[];
  onToggle: (userId: string) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const height = size === "sm" ? "min-h-9" : "min-h-11";
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {members.map((member) => {
        const on = selected.includes(member.userId);
        return (
          <button
            key={member.userId}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => {
              onToggle(member.userId);
            }}
            className={`inline-flex ${height} items-center gap-1.5 rounded-full border py-1 pr-3 pl-1.5 text-sm font-medium transition-colors disabled:cursor-default ${
              on
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong bg-surface text-muted hover:bg-surface-muted"
            }`}
          >
            <Avatar name={member.displayName} position={member.position} size="sm" />
            <span className={on ? "" : "line-through decoration-muted/60"}>
              {member.displayName}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A percentage box that lets you type "33." on the way to "33.33" without the number jumping. */
export function PercentInput({
  id,
  label,
  basisPoints,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  basisPoints: number;
  onChange: (basisPoints: number) => void;
  disabled?: boolean;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed ?? formatBasisPoints(basisPoints);
  const invalid = typed !== null && readBasisPoints(typed) === undefined;
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={shown}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          setTyped(event.target.value);
          const parsed = readBasisPoints(event.target.value);
          if (parsed !== undefined) onChange(parsed);
        }}
        onBlur={() => {
          setTyped(null);
        }}
        className={`num min-h-9 w-20 rounded-lg border bg-surface px-2 text-right text-base ${
          invalid ? "border-negative" : "border-border-strong"
        }`}
      />
      <span className="text-sm text-muted" aria-hidden="true">
        %
      </span>
    </div>
  );
}
