/*
 * Copyright © 2026, Commonwealth Scientific and Industrial Research
 * Organisation (CSIRO) ABN 41 687 119 230.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * @author John Grimes
 */

import eslint from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import jsdocPlugin from "eslint-plugin-jsdoc";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores: build output, generated code and vendored test data.
  {
    ignores: [
      "**/.claude/**",
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "out/**",
      "src/generated/**", // Generated ANTLR grammar files.
      "sqlonfhir/**", // SQL on FHIR test suite submodule.
      "**/*.d.ts",
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  jsdocPlugin.configs["flat/recommended-typescript"],
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  unicorn.configs.recommended,

  // Type-aware parsing for every TypeScript file, plus project-wide rule
  // adjustments.
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import/resolver": {
        typescript: { alwaysTryTypes: true },
        node: true,
      },
    },
    rules: {
      // Unicorn adjustments: ported modules keep PascalCase filenames (see
      // plan.md Constitution Check) and SQL/JSON handling uses null.
      "unicorn/filename-case": [
        "error",
        { cases: { camelCase: true, pascalCase: true } },
      ],
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
    },
  },

  // Plain JavaScript files (this config) are not type-checked.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },

  // TypeScript sources.
  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    rules: {
      // TypeScript-specific rules for medical/healthcare code.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      // Naming conventions.
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "objectLiteralProperty",
          modifiers: ["requiresQuotes"],
          format: null,
        },
        {
          selector: "default",
          format: ["camelCase"],
          leadingUnderscore: "allow",
          trailingUnderscore: "forbid",
        },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE"],
        },
        {
          selector: "objectLiteralProperty",
          format: null,
        },
        {
          selector: "typeProperty",
          format: null,
        },
        {
          selector: "typeLike",
          format: ["PascalCase"],
        },
        {
          selector: "enumMember",
          format: ["PascalCase"],
        },
      ],

      // JSDoc: public API must be documented.
      "jsdoc/require-jsdoc": [
        "warn",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
          },
        },
      ],

      // Import ordering.
      "import/order": [
        "error",
        {
          groups: [
            ["builtin", "external"],
            "internal",
            ["parent", "sibling", "index"],
            "type",
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "import/no-duplicates": "error",

      // Code quality and safety rules for healthcare data.
      complexity: ["error", 20],
      "max-depth": ["error", 8],
      "max-lines-per-function": ["error", 120],
      "no-console": "off",
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
      "no-throw-literal": "error",
      // Port diffability with sof-mssql: keep the reference's spelling and
      // import idioms where the rule is purely stylistic.
      "unicorn/text-encoding-identifier-case": "off",
      "unicorn/import-style": "off",
      "unicorn/prefer-string-slice": "off",
      "unicorn/prefer-spread": "off",
      "unicorn/prefer-top-level-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },

  // Ported modules keep a handful of verified imperative constructs that the
  // style rules would rewrite without behavioural benefit.
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/prefer-optional-chain": "off",
      "unicorn/prefer-ternary": "off",
      "unicorn/prefer-includes-over-repeated-comparisons": "off",
    },
  },

  // Test files.
  {
    files: ["src/**/*.test.ts", "test/**/*.ts"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "jsdoc/require-jsdoc": "off",
      "jsdoc/tag-lines": "off",
      "max-lines-per-function": "off",
      complexity: "off",
      // The reference (and common Node practice) uses "utf-8" spellings and
      // CRLF-safe sort helpers; keep the port diffable.
      "unicorn/no-array-sort": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/no-process-exit": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/text-encoding-identifier-case": "off",
      "unicorn/import-style": "off",
      "unicorn/prefer-ternary": "off",
      "unicorn/prefer-includes-over-repeated-comparisons": "off",
      "vitest/no-conditional-expect": "off",
      "vitest/valid-title": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },

  // CLI entry points legitimately call process.exit for exit codes.
  {
    files: ["src/cli.ts", "src/load.ts", "src/export.ts"],
    rules: {
      "unicorn/no-process-exit": "off",
    },
  },

  // Configuration files.
  {
    files: ["*.config.ts", "*.config.mjs"],
    rules: {
      "jsdoc/require-jsdoc": "off",
      // Plugins ship mixed CJS/ESM entry points; default imports are intended.
      "import/no-named-as-default": "off",
      "import/no-named-as-default-member": "off",
    },
  },
);
