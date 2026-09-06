// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '.tools/**',
      '.data/**',
      'apps/web/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='child_process'][callee.property.name=/^exec$|^execSync$/]",
          message: 'Shell execution is forbidden. Use spawn() with an argument array.',
        },
        {
          selector:
            "ImportDeclaration[source.value='child_process'] ImportSpecifier[imported.name=/^exec$|^execSync$/]",
          message: 'Shell execution is forbidden. Use spawn() with an argument array.',
        },
        {
          selector:
            "ImportDeclaration[source.value='node:child_process'] ImportSpecifier[imported.name=/^exec$|^execSync$/]",
          message: 'Shell execution is forbidden. Use spawn() with an argument array.',
        },
      ],
    },
  },

  {
    // Tests are excluded from the emitting projects so they stay out of dist/, which
    // means the project service cannot find a config that includes them. They have their
    // own non-emitting project instead, named explicitly here.
    files: [
      'packages/**/*.test.ts',
      'apps/api/**/*.test.ts',
      'apps/worker/**/*.test.ts',
      'test/**/*.ts',
      '*.config.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.tests.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'no-console': 'off',
    },
  },

  {
    // The web tests resolve the way the browser bundle does, so they are checked
    // against the app's own project rather than the Node one.
    files: ['apps/web/**/*.test.ts', 'apps/web/**/*.test.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./apps/web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['scripts/**/*.mjs', '*.config.js', '*.config.mjs', '**/*.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },

  prettier,
);
