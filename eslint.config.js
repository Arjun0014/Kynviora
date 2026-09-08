// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      // `apps/mobile/src` is linted - see the block at the bottom of this file. What stays ignored
      // is the generated and native scaffolding: `.expo/` is written by the router, `android/` and
      // `ios/` by `expo prebuild`, and neither is source anybody edits.
      'apps/**/.expo/**',
      'apps/**/android/**',
      'apps/**/ios/**',
      'apps/**/*.js',
      'apps/**/expo-env.d.ts',
      // `supabase/functions` is Deno, not this workspace. It has no `tsconfig` here, its globals
      // are `Deno.*`, and it is deployed rather than built - so the type-aware rules have nothing
      // to run against and report every file as outside the project service. What it is and why
      // it exists is in the file's own header (DEC-126).
      'supabase/functions/**',
      'KYNVIORA_PROJECT_SPEC/**',
      // `scratchpad/` is where the device harnesses and verification runs put their working
      // output, and `.gitignore` already says it is not project content. It is not in any
      // `tsconfig`, so the type-aware rules report every file in it as outside the project service
      // - which meant a probe script left there while investigating `DEV-096` failed
      // `npm run verify` over a file nobody had committed. A gate that goes red for what is not
      // in the repository teaches the same lesson `DEV-096` did.
      'scratchpad/**',
      // The Claude Design handoff bundle. `docs/kynviora-premium-mobile-experience/` is an
      // export from claude.ai/design: HTML/CSS/JS prototypes plus the design brief, kept in the
      // repository so the approved V3 direction is auditable against what was actually built. It
      // is a *reference artifact*, not source. Its `support.js` is the design tool's own runtime
      // and is in no `tsconfig`, so the type-aware rules report it as outside the project service
      // - which is how a bundle nobody wrote failed `npm run verify` the moment it was copied in.
      // The same reason it is ignored is the reason it must not be reformatted: it is evidence of
      // what was approved, and evidence that a formatter has rewritten is a weaker record.
      'docs/kynviora-premium-mobile-experience/**',
      'eslint.config.js',
      'vitest.config.ts',
      'vitest.mobile.config.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: [] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],

      // Spec 09 requires assessment replay to reproduce results exactly (DEC-003).
      // Ambient time is the most common cause of irreproducible domain logic.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Safety-critical code must receive time via an injected Clock, not new Date(). Use clock.now().',
        },
      ],
    },
  },
  {
    // `apps/mobile/test/**` joins this list for the reason `db/harness/**` is on it: a harness
    // walks a structure the type system cannot describe - there, a database row; here, a rendered
    // tree - and typing every step of that walk would be describing `react-test-renderer`'s
    // internals rather than testing the app.
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      'packages/fixtures/**',
      'db/harness/**',
      'scripts/**',
      'apps/mobile/test/**',
    ],
    rules: {
      'no-restricted-syntax': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // The mobile app
  // ---------------------------------------------------------------------------
  // `apps/**` was ignored entirely until now, and that is half of `DEV-043`'s explanation: eight
  // call sites reached for `crypto.randomUUID()` on an engine with no `crypto`, and every gate the
  // project runs was green because the one tree that could not run them was also the one tree
  // nobody checked. The mobile typecheck closed the other half (DEC-112); this closes this one.
  //
  // The two rules that earn their place here are the hooks ones, and they are not style. Trap 174
  // is a `ReminderProvider` effect that guarded itself with "already running, do nothing" and
  // therefore dropped the only pass that had the client, the profile and the projection together -
  // three cold launches, zero alarms, on a build whose reminder engine was correct. `DEV-044` and
  // `DEV-045` are the same family: an effect or a memo whose inputs moved and whose result did
  // not. `exhaustive-deps` is the only automated thing that looks at that at all.
  //
  // Type-aware, through `apps/mobile/tsconfig.json` rather than the root one: that config is what
  // tells the compiler a phone has no DOM and no Node globals, and linting these files under the
  // root project would hand them back the very `lib` DEC-112 took away.
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // `x != null` stays allowed here and nowhere else. Every other tree passes strict `eqeqeq`
      // and keeps it, because there the two forms mean the same thing. Here they do not: a React
      // prop declared `state?: ScreenStateKind | null` is absent as `undefined` *and* as `null`,
      // and the widely-used `!= null` excludes both while `!== null` lets `undefined` through to a
      // component that would then render a state nobody set. Rewriting the six sites as
      // `!== null && !== undefined` would be longer, harder to read, and no safer - TypeScript
      // narrows `!= null` exactly. What the rule is actually for - `0 == ''`, `'1' == 1` - is
      // still an error, because `null: 'ignore'` exempts only comparisons against `null`.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
