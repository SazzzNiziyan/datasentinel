// @ts-check
// Lint configuration for the whole workspace (D-14). Run from the root:
// `pnpm lint`. Formatting belongs to Prettier; see the last entry.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '**/node_modules/', 'packages/db/src/generated/']),

  // Every TypeScript file: type-aware rules through the TS project service,
  // which uses the nearest tsconfig.json and the repo's own TypeScript.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Type-only imports must say `import type`. The rule reads
      // experimentalDecorators + emitDecoratorMetadata from the tsconfig and
      // then skips files with decorators, so it never rewrites a NestJS
      // injected class to `import type` (which would break injection).
      // Keep both flags in every Nest tsconfig; parserOptions cannot replace
      // them. In decorated files, `tsc` (verbatimModuleSyntax) is the check.
      '@typescript-eslint/consistent-type-imports': 'error',
      // Every state in a union (incident, check run, ...) must be handled.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test runs describe/it callbacks itself; awaiting is optional.
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'suite', 'test'] },
          ],
        },
      ],
      // Same as tsc's noUnusedLocals: `const { a, ...rest } = x` may omit `a`.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // NestJS apps and Node packages: Node globals.
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'packages/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // React app: browser globals, hooks and fast-refresh rules.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },

  // Tests are never hot-reloaded, so helpers may export components and
  // functions together.
  {
    files: ['apps/web/test/**/*.{ts,tsx}'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },

  // Plain JS config files are not in any tsconfig: lint them without types.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // Last: turn off every stylistic rule that Prettier owns.
  prettier,
);
