import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
  // A site's callbacks to page.evaluate() and friends run in the page.
  {
    files: ["src/sites/**/*.js"],
    languageOptions: { globals: { ...globals.node, window: "readonly", document: "readonly" } },
  },
  // Scripts injected into a site's pages run in the browser, not Node.
  {
    files: ["src/sites/*/*.page.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },
];
