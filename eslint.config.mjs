import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Money must never touch floating point: forbid the usual ways it sneaks in.
    files: ["src/lib/money/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money is integer minor units; parse digits as strings." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "Money is integer minor units." },
        { object: "Math", property: "round", message: "Use integer rounding (divRoundHalfUp)." },
        { object: "Math", property: "floor", message: "Use bigint division." },
        { object: "Math", property: "ceil", message: "Use bigint division." },
        { object: "Math", property: "trunc", message: "Use bigint division." },
      ],
    },
  },
  {
    // Ledger data is reached only through the group-scoped store in src/server/ledger.
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db", "@/db/*", "drizzle-orm", "drizzle-orm/*", "pg"],
              message:
                "Pages and components get ledger data only through the store from '@/server/runtime' (openStore).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "**/*.test.ts", "src/test-support/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      // `expect(() => fn()).toThrow()` is the idiomatic shape.
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
]);
