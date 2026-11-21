const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        ...globals.node,
        AbortController: "readonly",
        AbortSignal: "readonly",
        chrome: "readonly",
        navigator: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "prefer-const": "error",
      "no-sparse-arrays": "off",
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    },
  },
];