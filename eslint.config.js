import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import security from 'eslint-plugin-security'
import promise from 'eslint-plugin-promise'
// this pulls in eslint-config-prettier, which is why that package is a declared
// devDependency despite never being imported by name (it is an *optional* peer of
// eslint-plugin-prettier, so npm will not reliably install it on its own)
import prettierRecommended from 'eslint-plugin-prettier/recommended'

// Replaces the .eslintrc that extended eslint-config-oceanprotocol. That config is
// pinned to eslint ^8 and cannot follow eslint to flat config, so the preset is
// composed here instead.
//
// The rule set is held at the severity the old gate actually resolved to
// (0 errors, 40 warnings), taken from `eslint --print-config` on the previous
// setup. Rules that eslint 9/10 and the newer plugins add on top are switched off
// rather than fixed here, so this dependency bump does not double as a lint-debt PR.
export default tseslint.config(
  {
    // only TypeScript is linted - the .js in the tree is build output, k6
    // performance scripts or plain node helpers
    ignores: [
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'dist/',
      'coverage/',
      '.nyc_output/',
      'databases/',
      'c2d_storage/',
      'logs/'
    ]
  },
  {
    files: ['**/*.ts'],
    // a stale eslint-disable is a lie about the code, so these are errors rather
    // than warnings: it keeps the directives honest as rules move around
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    extends: [
      js.configs.recommended,
      // parser + plugin wiring only. The old config never pulled in
      // @typescript-eslint's `recommended`, and adopting it here would add
      // ~1350 no-explicit-any errors unrelated to the dependency bump.
      tseslint.configs.base,
      security.configs.recommended,
      prettierRecommended
    ],
    // eslint-plugin-promise is registered but not extended: the old config
    // enabled promise/param-names only, not the plugin's recommended set
    plugins: { promise },
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.mocha,
        NodeJS: true,
        RequestInit: true
      }
    },
    rules: {
      // from .eslintrc
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-destructuring': ['warn', { object: true, array: false }],
      'no-dupe-class-members': ['warn'],
      'no-useless-constructor': ['warn'],
      'constructor-super': ['warn'],
      'require-await': 'error',

      // from eslint-config-standard, via eslint-config-oceanprotocol
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, vars: 'all' }
      ],
      'no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }
      ],
      'no-constant-condition': ['error', { checkLoops: false }],
      'promise/param-names': 'error',
      // these three cost nothing on the current tree and keep the existing
      // eslint-disable comments for them meaningful. Three more that standard
      // supplied are deliberately absent: no-await-in-loop (264 violations),
      // camelcase (111) and no-use-before-define (54) - the old gate did not
      // enforce them either, so turning them on is its own piece of work.
      'no-new': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',

      // added to eslint's recommended set after v8 - not part of the old gate
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',

      // eslint-config-oceanprotocol explicitly disabled this; it fires on every
      // bracket access and would add ~128 warnings
      'security/detect-object-injection': 'off'
    }
  }
)
