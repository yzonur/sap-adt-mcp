// Minimal ESLint flat config — modest rules so contributions aren't blocked by style.
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      "no-undef": "error",
      "prefer-const": "warn",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
    },
  },
  {
    files: ["test/**/*.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },
];
