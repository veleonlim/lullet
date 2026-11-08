/**
 * `pnpm check:env` checks a set of production settings before you deploy, using the same
 * rules the server applies when it starts. It reads .env, then .env.production.local on top.
 * It prints which variables are set or missing and what is wrong, but never a value.
 */
import { ENV_VARIABLES, checkProductionEnv } from "@/lib/config/env";

const problems = checkProductionEnv(process.env);
const flagged = new Map(problems.map((problem) => [problem.name, problem.message]));

for (const variable of ENV_VARIABLES) {
  if (variable.requirement === "test-only" && !process.env[variable.name]) continue;
  const state = flagged.has(variable.name)
    ? `PROBLEM  ${flagged.get(variable.name) ?? ""}`
    : process.env[variable.name]?.trim()
      ? "ok"
      : "not set (optional)";
  console.log(`${variable.name.padEnd(26)} ${variable.requirement.padEnd(9)} ${state}`);
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} problem(s). See docs/ENVIRONMENT.md.`);
  process.exitCode = 1;
} else {
  console.log("\nAll production settings look right.");
}
