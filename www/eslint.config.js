import eslint from "@eslint/js"
import tseslint from "@typescript-eslint/eslint-plugin"
import typescript from "@typescript-eslint/parser"
import importPlugin from "eslint-plugin-import"
import unusedImports from "eslint-plugin-unused-imports"
import globals from "globals"

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
    ],
  },
  eslint.configs.recommended,
  {
    files: [
      "**/*.{js,jsx,ts,tsx}"
    ],
    plugins: {
      "@typescript-eslint": tseslint,
      "unused-imports": unusedImports,
      "import": importPlugin,
    },
    languageOptions: {
      parser: typescript,
      parserOptions: {
        ecmaVersion: "latest",
      },
      globals: {
        ...globals.browser,
        FileSystemSyncAccessHandle: "readonly",
      },
    },
    rules: {
      "indent": ["error", 2, {
        "SwitchCase": 1,
        "VariableDeclarator": 1,
        "outerIIFEBody": 1,
        "MemberExpression": 1,
        "FunctionDeclaration": { "parameters": 1, "body": 1 },
        "FunctionExpression": { "parameters": 1, "body": 1 },
        "CallExpression": { "arguments": 1 },
        "ArrayExpression": 1,
        "ObjectExpression": 1,
        "ImportDeclaration": 1,
        "flatTernaryExpressions": false,
        "ignoreComments": false
      }],
      "import/order": ["error", {
        "groups": [
          "builtin",
          "external",
          "internal",
          ["parent", "sibling"],
          "index",
          "object",
          "type"
        ],
        "newlines-between": "never",
        "alphabetize": {
          "order": "asc",
          "caseInsensitive": true
        },
        "pathGroups": [
          {
            "pattern": "@/**",
            "group": "internal"
          }
        ]
      }],
      "no-empty": "off",
      "no-import-assign": "off",
      "no-irregular-whitespace": "off",
      "no-redeclare": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        "vars": "all",
        "args": "after-used",
        "ignoreRestSiblings": true,
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_"
      }],
      "unused-imports/no-unused-imports": "error",
      "semi": ["error", "never"],
      "no-multiple-empty-lines": ["error", { "max": 1, "maxEOF": 1 }],
      "eol-last": ["error", "always"],
      "object-curly-spacing": ["error", "always"]
    }
  }
]
