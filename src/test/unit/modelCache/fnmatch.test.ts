import { expect } from 'chai'
import { spawnSync } from 'child_process'
import {
  fnmatchToRegExp,
  matchesAllowPatterns
} from '../../../components/modelCache/fnmatch.js'

// The cache must select exactly the files that huggingface_hub's
// snapshot_download(allow_patterns=...) selects, i.e. filter_repo_objects on POSIX:
//   - a pattern ending in '/' gets '*' appended (_add_wildcard_to_directories),
//   - fnmatch.fnmatch, which on POSIX is fnmatch.fnmatchcase (os.path.normcase is the
//     identity): case-sensitive, '*' and '?' also match '/', no '**',
//   - a file is kept when ANY pattern matches.
// matchesAllowPatterns additionally normalizes '\' to '/' in both pattern and path (before
// the trailing-'/' rule), and so does the reference below.
//
// Every expected value in PYTHON_TABLE was GENERATED with CPython 3.14.3, not written by
// hand. To regenerate, run this with python3 over the same (category, patterns, path) rows:
//
//   import fnmatch
//   def hf_allow(path, patterns):
//       name = path.replace('\\', '/')
//       for raw in patterns:
//           p = raw.replace('\\', '/')
//           if p.endswith('/'):
//               p += '*'
//           if fnmatch.fnmatchcase(name, p):
//               return True
//       return False
//
// (huggingface_hub itself raises IndexError on an empty pattern; the reference treats ''
// as plain fnmatch does: it only matches the empty path.)

type Row = [
  category: string,
  patterns: string | string[],
  path: string,
  expected: boolean
]

const PYTHON_TABLE: Row[] = [
  ['star', '*.safetensors', 'model.safetensors', true],
  ['star', '*.safetensors', 'split_files/vae/qwen_image_vae.safetensors', true],
  ['star', 'split_files/*', 'split_files/vae/x.safetensors', true],
  ['star', 'split_files/*.json', 'split_files/a/b/config.json', true],
  ['star', '*/config.json', 'config.json', false],
  ['star', '*/config.json', 'a/b/config.json', true],
  ['star', '*', 'a/b/c', true],
  ['star', 'a*b', 'a/x/b', true],
  ['star', '*.safetensors', 'model.safetensors.index.json', false],
  ['star', 'tokenizer*', 'tokenizer.model', true],
  ['star', 'original/*', 'original/params.json', true],
  ['star', 'model-*-of-*.safetensors', 'model-00001-of-00002.safetensors', true],
  ['star', '*/*/*', 'a/b', false],
  [
    'question',
    'model-0000?-of-00002.safetensors',
    'model-00001-of-00002.safetensors',
    true
  ],
  ['question', '?.json', 'ab.json', false],
  ['question', 'a?b', 'a/b', true],
  ['question', '??', 'a', false],
  ['question', 'config.json?', 'config.json', false],
  ['class', 'model.[abc]', 'model.b', true],
  ['class', 'model.[abc]', 'model.d', false],
  ['class', 'model.[!abc]', 'model.d', true],
  ['class', 'model.[!abc]', 'model.a', false],
  ['class', 'a[/]b', 'a/b', true],
  ['class', 'a[!x]b', 'a/b', true],
  ['class', '[a!]', '!', true],
  ['bracket', '[]abc]', ']', true],
  ['bracket', '[]abc]', 'b', true],
  ['bracket', '[]abc]', 'd', false],
  ['bracket', '[!]abc]', ']', false],
  ['bracket', '[!]abc]', 'd', true],
  ['bracket', '[]]', ']', true],
  ['bracket', '[]', '[]', true],
  ['bracket', '[!]', '[!]', true],
  ['bracket', '[!]', 'x', false],
  ['bracket', '[!]]', 'a', true],
  ['bracket', '[!]]', ']', false],
  ['bracket', '[[]', '[', true],
  ['bracket', '[a[]', '[', true],
  ['bracket', '[^a]', '^', true],
  ['bracket', '[^a]', 'b', false],
  ['bracket', '[!^a]', 'b', true],
  ['bracket', '[!^a]', '^', false],
  ['bracket', '[a&b]', '&', true],
  ['bracket', '[a&&b]', '&', true],
  ['bracket', '[a||b]', '|', true],
  ['bracket', '[a|b]', 'c', false],
  ['bracket', '[~~]', '~', true],
  ['range', '[a-z].bin', 'q.bin', true],
  ['range', '[a-z].bin', 'Q.bin', false],
  ['range', '[!a-z].bin', 'Q.bin', true],
  ['range', '[0-9][0-9].json', '42.json', true],
  ['range', '[a-]', '-', true],
  ['range', '[-a]', '-', true],
  ['range', '[!-a]', '-', false],
  ['range', '[!-a]', 'b', true],
  ['range', '[%--]', ',', true],
  ['range', '[--z]', 'm', true],
  ['range', '[a-c-e]', '-', true],
  ['range', '[a-c-e]', 'd', false],
  ['range', '[]-a]', '_', true],
  ['range', '[]-]', '-', true],
  ['range', '[]-]', ']', true],
  ['range', '[a-z0-9_]*.bin', 'model_01.bin', true],
  ['range', '[z-a]', 'm', false],
  ['range', '[a--]', '-', false],
  ['unclosed', '[abc', '[abc', true],
  ['unclosed', '[abc', 'a', false],
  ['unclosed', 'model[.json', 'model[.json', true],
  ['unclosed', 'a[!', 'a[!', true],
  ['unclosed', '*[', 'x[', true],
  ['meta', 'model.safetensors', 'modelXsafetensors', false],
  ['meta', 'a+b.json', 'a+b.json', true],
  ['meta', 'a+b.json', 'aab.json', false],
  ['meta', '(a|b).json', '(a|b).json', true],
  ['meta', '(a|b).json', 'a.json', false],
  ['meta', '^config$', '^config$', true],
  ['meta', '^config$', 'config', false],
  ['meta', 'x{2}.txt', 'x{2}.txt', true],
  ['meta', 'x{2}.txt', 'xx.txt', false],
  ['meta', '$HOME/*', '$HOME/x', true],
  ['meta', 'a]b', 'a]b', true],
  ['meta', 'a-b', 'a-b', true],
  ['dot', '*', '.gitattributes', true],
  ['dot', '*.json', '.hidden.json', true],
  ['dot', '.*', '.gitattributes', true],
  ['dot', '.*', 'README.md', false],
  ['dot', '*/.*', 'a/.hidden', true],
  ['dot', '?gitattributes', '.gitattributes', true],
  ['case', '*.JSON', 'config.json', false],
  ['case', '*.json', 'CONFIG.JSON', false],
  ['case', 'README.md', 'readme.md', false],
  ['case', '[A-Z]*', 'readme', false],
  ['case', '[A-Z]*', 'Readme', true],
  ['slash', 'split_files/', 'split_files/vae/a.safetensors', true],
  ['slash', 'split_files/', 'split_files', false],
  ['slash', 'split_files/', 'other/split_files/a', false],
  ['slash', 'vae/', 'split_files/vae/a', false],
  ['slash', '*/vae/', 'split_files/vae/a', true],
  ['globstar', '**', 'a/b/c.json', true],
  ['globstar', '**/*.safetensors', 'a.safetensors', false],
  ['globstar', '**/*.safetensors', 'sub/a.safetensors', true],
  ['globstar', 'a/**/b', 'a/b', false],
  ['globstar', 'a/**/b', 'a/x/b', true],
  ['globstar', '***.json', 'x.json', true],
  ['backslash', 'dir\\*.json', 'dir/x.json', true],
  ['backslash', 'dir/*.json', 'dir\\x.json', true],
  ['backslash', 'split_files\\', 'split_files/a', true],
  ['backslash', 'a\\d.txt', 'a/d.txt', true],
  ['backslash', 'a\\d.txt', 'a5.txt', false],
  ['backslash', '[\\]', '/', true],
  ['escaped', 'a[[]1].json', 'a[1].json', true],
  ['escaped', 'a[*].json', 'a*.json', true],
  ['escaped', 'a[*].json', 'ab.json', false],
  ['escaped', 'what[?].txt', 'what?.txt', true],
  ['escaped', 'what[?].txt', 'whatX.txt', false],
  ['newline', 'a?b', 'a\nb', true],
  ['newline', '*', 'a\nb', true],
  ['multi', [], 'config.json', false],
  ['multi', ['*.json', '*.safetensors'], 'model.safetensors', true],
  ['multi', ['*.json', '*.txt'], 'model.safetensors', false],
  ['multi', ['[z-a]', '*.bin'], 'x.bin', true],
  ['multi', [''], 'config.json', false],
  ['unicode', '?', '\u00e9', true],
  ['unicode', '???', '\u65e5\u672c\u8a9e', true],
  ['unicode', '[\u00e9]', '\u00e9', true],
  ['unicode', '*\ud83d\ude00*', 'a\ud83d\ude00b', true],
  ['unicode', '?', '\ud83d\ude00', true],
  ['unicode', '??', '\ud83d\ude00', false],
  ['unicode', '[!a]', '\ud83d\ude00', true],
  ['unicode', '[\ud83d\ude00]', '\ud83d\ude00', true],
  ['unicode', 'x?y', 'x\ud83d\ude00y', true],
  ['reversed', '[z-ab]', 'b', true],
  ['reversed', '[bz-a]', 'b', true],
  ['reversed', '[!z-a]', 'm', true],
  ['reversed', '[a-cz-a]', 'b', true]
]

describe('modelCache fnmatch', () => {
  describe('matchesAllowPatterns agrees with CPython fnmatchcase + huggingface_hub rules', () => {
    it('covers every required construct with at least 40 generated rows', () => {
      expect(PYTHON_TABLE.length).to.be.at.least(40)
      const categories = new Set(PYTHON_TABLE.map(([c]) => c))
      for (const c of [
        'star',
        'question',
        'class',
        'bracket',
        'range',
        'unclosed',
        'meta',
        'dot',
        'case',
        'slash',
        'globstar',
        'backslash'
      ]) {
        expect(categories.has(c), c).to.equal(true)
      }
      // both outcomes are exercised, so a constant answer cannot pass the table
      expect(PYTHON_TABLE.filter((r) => r[3]).length).to.be.at.least(20)
      expect(PYTHON_TABLE.filter((r) => !r[3]).length).to.be.at.least(20)
    })

    for (const [category, patterns, file, expected] of PYTHON_TABLE) {
      const list = Array.isArray(patterns) ? patterns : [patterns]
      it(`[${category}] ${JSON.stringify(patterns)} vs ${JSON.stringify(file)} -> ${expected}`, () => {
        expect(matchesAllowPatterns(file, list)).to.equal(expected)
      })
    }
  })

  describe('fnmatchToRegExp', () => {
    it('anchors the match to the whole path', () => {
      const re = fnmatchToRegExp('config.json')
      expect(re.test('config.json')).to.equal(true)
      expect(re.test('xconfig.json')).to.equal(false)
      expect(re.test('config.jsonx')).to.equal(false)
      expect(re.test('a/config.json')).to.equal(false)
    })

    it('returns a stateless RegExp (no g/y flag): repeated tests give the same answer', () => {
      const re = fnmatchToRegExp('*.safetensors')
      expect(re.global).to.equal(false)
      expect(re.sticky).to.equal(false)
      for (let i = 0; i < 3; i++) {
        expect(re.test('model.safetensors')).to.equal(true)
        expect(re.test('config.json')).to.equal(false)
      }
    })

    it('collapses runs of * exactly like a single *', () => {
      for (const file of ['a/b.json', 'x.json', '.json', 'json']) {
        expect(fnmatchToRegExp('***.json').test(file), file).to.equal(
          fnmatchToRegExp('*.json').test(file)
        )
      }
    })
  })

  describe('matchesAllowPatterns input handling', () => {
    it('does not mutate the pattern list it is given', () => {
      const patterns = ['split_files/', 'a\\*.json']
      matchesAllowPatterns('split_files/vae/a.safetensors', patterns)
      expect(patterns).to.deep.equal(['split_files/', 'a\\*.json'])
    })

    it('selects from a realistic Hub file list the same files as allow_patterns would', () => {
      const repo = [
        '.gitattributes',
        'README.md',
        'config.json',
        'generation_config.json',
        'model-00001-of-00002.safetensors',
        'model-00002-of-00002.safetensors',
        'model.safetensors.index.json',
        'original/consolidated.00.pth',
        'original/params.json',
        'tokenizer.json',
        'tokenizer_config.json'
      ]
      // python3: [f for f in repo if any(fnmatchcase(f, p) for p in pats)]
      const pats = ['*.json', '*.safetensors', 'tokenizer*']
      expect(repo.filter((f) => matchesAllowPatterns(f, pats))).to.deep.equal([
        'config.json',
        'generation_config.json',
        'model-00001-of-00002.safetensors',
        'model-00002-of-00002.safetensors',
        'model.safetensors.index.json',
        'original/params.json',
        'tokenizer.json',
        'tokenizer_config.json'
      ])
      expect(repo.filter((f) => matchesAllowPatterns(f, ['original/']))).to.deep.equal([
        'original/consolidated.00.pth',
        'original/params.json'
      ])
    })
  })

  // CPython compiles interior `*fixed` pairs as atomic groups, so a non-matching name is
  // rejected in linear time. A port that emits plain `.*` for every star backtracks
  // O(len^stars): an operator pattern with a few stars plus Hub file names chosen by the
  // repo owner (up to 1024 chars, up to 20000 siblings) would block the node's event loop.
  // Run in a child process so a regression cannot hang this test run.
  describe('backtracking', () => {
    it('rejects adversarial names quickly, like CPython (no catastrophic backtracking)', function () {
      this.timeout(5000)
      const moduleUrl = new URL(
        '../../../components/modelCache/fnmatch.js',
        import.meta.url
      ).href
      const script = [
        `const { matchesAllowPatterns } = await import(${JSON.stringify(moduleUrl)})`,
        'const cases = [',
        "  ['*-*-*.safetensors', '-'.repeat(1024)],",
        "  ['*a*a*a*a*a*a*b', 'a'.repeat(200)],",
        "  ['model-*-of-*-*.safetensors', 'model-' + '-of-'.repeat(250)]",
        ']',
        'const out = []',
        'for (const [p, f] of cases) {',
        '  const t = Date.now()',
        '  out.push({ p, matched: matchesAllowPatterns(f, [p]), ms: Date.now() - t })',
        '}',
        'console.log(JSON.stringify(out))'
      ].join('\n')
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 1500
      })
      expect(res.signal, 'matching did not finish within 1.5 s and was killed').to.equal(
        null
      )
      expect(res.status, res.stderr).to.equal(0)
      const results = JSON.parse(res.stdout.trim()) as Array<{
        p: string
        matched: boolean
        ms: number
      }>
      for (const r of results) {
        expect(r.matched, r.p).to.equal(false)
        expect(r.ms, r.p).to.be.below(250)
      }
    })
  })
})
