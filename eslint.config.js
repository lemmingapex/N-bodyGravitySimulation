import js from "@eslint/js";
import globals from "globals";

export default [
	{ ignores: ["vendor/**", "node_modules/**", "coverage/**"] },
	js.configs.recommended,
	{
		languageOptions: { ecmaVersion: "latest", sourceType: "module" },
		linterOptions: { reportUnusedDisableDirectives: "error" },
		rules: {
			eqeqeq: ["error", "always"],
			"no-var": "error",
			"prefer-const": "error",
			"no-shadow": "error",
			"no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"object-shorthand": "error",
		},
	},
	{ files: ["src/**/*.js"], languageOptions: { globals: globals.browser } },
	{ files: ["coi-sw.js"], languageOptions: { globals: globals.serviceworker } },
	{
		files: ["test/**/*.js", "scripts/**/*.js", "*.config.js"],
		languageOptions: { globals: globals.node },
	},
	{
		// page.evaluate() callbacks run inside the browser.
		files: ["test/e2e/**/*.js"],
		languageOptions: { globals: { ...globals.node, ...globals.browser } },
	},
];
