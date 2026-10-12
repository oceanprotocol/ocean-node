import { expect } from 'chai'
import path from 'path'
import {
  SHA1_RE,
  SHA256_RE,
  isCommit,
  isValidRepoFilePath,
  isValidRepoId,
  isValidRevisionName,
  pathsOverlap,
  repoFolderName,
  safeJoin
} from '../../../components/modelCache/validate.js'

// Every string that becomes part of a cache path (template JSON, workflow graphs, curated
// config, Hub API answers, state.json read back) goes through these checks.

const SHA = '0123456789abcdef0123456789abcdef01234567'
const NOT_STRINGS: unknown[] = [
  undefined,
  null,
  0,
  42,
  true,
  {},
  [],
  ['org/name'],
  () => 'org/name'
]

// Assertion label that spells out control and non-ASCII characters (\u0085 would otherwise
// print as nothing at all).
function show(v: unknown): string {
  if (typeof v !== 'string') return String(v)
  return JSON.stringify(v).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

describe('modelCache validate', () => {
  describe('isValidRepoId', () => {
    it('accepts owner/name ids as the Hub writes them', () => {
      for (const id of [
        'Qwen/Qwen3.8-27B-FP8',
        'google/gemma-4-31B-it',
        'Comfy-Org/Qwen-Image_ComfyUI',
        'zai-org/GLM-5.3-Flash',
        'lightx2v/Qwen-Image-Lightning',
        'a/b',
        '0/9',
        'org.name/model.v2',
        'org_x/model_v2-final.1'
      ]) {
        expect(isValidRepoId(id), id).to.equal(true)
      }
    })

    it('accepts each part up to 96 characters and rejects 97', () => {
      expect(isValidRepoId(`${'a'.repeat(96)}/${'b'.repeat(96)}`)).to.equal(true)
      expect(isValidRepoId(`${'a'.repeat(97)}/b`)).to.equal(false)
      expect(isValidRepoId(`a/${'b'.repeat(97)}`)).to.equal(false)
    })

    it('requires exactly one owner and one name', () => {
      for (const id of [
        '',
        '/',
        'name',
        '/name',
        'org/',
        'org//name',
        'a/b/c',
        'org/name/'
      ]) {
        expect(isValidRepoId(id), id).to.equal(false)
      }
    })

    it("rejects '--' anywhere (it separates owner and name in the cache folder name)", () => {
      for (const id of ['org/na--me', 'org--x/name', 'org/name--', 'org/a---b']) {
        expect(isValidRepoId(id), id).to.equal(false)
      }
    })

    it("rejects '..' anywhere and ids ending in '.git' or '.'", () => {
      for (const id of [
        'org/na..me',
        'org/name..',
        'org/..',
        '../etc',
        'org/../x',
        'org/name.git',
        'org/name.'
      ]) {
        expect(isValidRepoId(id), id).to.equal(false)
      }
    })

    it('rejects an owner or name that does not start with a letter or digit', () => {
      for (const id of [
        'org/-name',
        'org/.name',
        'org/_name',
        '-org/name',
        '.org/name',
        '_org/name'
      ]) {
        expect(isValidRepoId(id), id).to.equal(false)
      }
    })

    it('rejects characters outside [A-Za-z0-9._-]', () => {
      for (const id of [
        'org/na me',
        'org/ name',
        'org/na\u00efve',
        'org/name\n',
        'org/name\u0000',
        'org\\name',
        'org/name:main',
        'org/name@main',
        'org/name?x',
        'org/name#x',
        'org/name%2F',
        'org/\u540d\u524d'
      ]) {
        expect(isValidRepoId(id), show(id)).to.equal(false)
      }
    })

    it('rejects non-strings', () => {
      for (const v of NOT_STRINGS) expect(isValidRepoId(v), String(v)).to.equal(false)
    })
  })

  describe('isCommit / SHA1_RE / SHA256_RE', () => {
    it('isCommit accepts exactly 40 lowercase hex characters', () => {
      expect(isCommit(SHA)).to.equal(true)
      expect(isCommit('f'.repeat(40))).to.equal(true)
      expect(SHA1_RE.test(SHA)).to.equal(true)
    })

    it('isCommit rejects other lengths, uppercase, non-hex and padded values', () => {
      for (const v of [
        '',
        'main',
        SHA.slice(0, 39),
        `${SHA}0`,
        SHA.toUpperCase(),
        `g${SHA.slice(1)}`,
        ` ${SHA}`,
        `${SHA}\n`,
        `${SHA.slice(0, 20)}/${SHA.slice(21)}`
      ]) {
        expect(isCommit(v), show(v)).to.equal(false)
      }
    })

    it('isCommit rejects non-strings', () => {
      for (const v of NOT_STRINGS) expect(isCommit(v), String(v)).to.equal(false)
    })

    it('SHA256_RE matches exactly 64 lowercase hex characters', () => {
      const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      expect(SHA256_RE.test(sha256)).to.equal(true)
      expect(SHA256_RE.test(sha256.slice(1))).to.equal(false)
      expect(SHA256_RE.test(`${sha256}0`)).to.equal(false)
      expect(SHA256_RE.test(sha256.toUpperCase())).to.equal(false)
      expect(SHA256_RE.test(`${sha256}\n`)).to.equal(false)
    })
  })

  describe('isValidRevisionName', () => {
    it('accepts branch and tag names', () => {
      for (const rev of [
        'main',
        'Main',
        'v1.0',
        'v1.0.0-rc1',
        'release_2024-10',
        'a',
        'fp8',
        'refs-pr-1',
        'deadbeefz'
      ]) {
        expect(isValidRevisionName(rev), rev).to.equal(true)
      }
    })

    it('accepts up to 100 characters and rejects 101', () => {
      expect(isValidRevisionName('r'.repeat(100))).to.equal(true)
      expect(isValidRevisionName('r'.repeat(101))).to.equal(false)
    })

    it('rejects a full 40-hex commit sha (a commit, never a ref name)', () => {
      expect(isValidRevisionName(SHA)).to.equal(false)
      expect(isValidRevisionName('f'.repeat(40))).to.equal(false)
    })

    it('rejects 7..39 lowercase hex characters (short shas the Hub resolves as commits)', () => {
      for (let n = 7; n <= 39; n++) {
        expect(isValidRevisionName(SHA.slice(0, n)), SHA.slice(0, n)).to.equal(false)
      }
      for (const rev of ['abcdef0', 'deadbeef', 'cafebabe', 'f'.repeat(39)]) {
        expect(isValidRevisionName(rev), rev).to.equal(false)
      }
    })

    it('treats hex shorter than the 7-character ambiguity floor as a name (design: 7-39)', () => {
      for (const rev of ['abcdef', 'cafe', 'beef', 'add']) {
        expect(isValidRevisionName(rev), rev).to.equal(true)
      }
    })

    it("rejects '..' anywhere", () => {
      for (const rev of ['v1..2', 'a..', 'main..x', '..', '..main']) {
        expect(isValidRevisionName(rev), rev).to.equal(false)
      }
    })

    it('rejects slashes (no refs/pr/N in v1) and path or rev-syntax characters', () => {
      for (const rev of [
        'refs/pr/1',
        'feature/x',
        'main/',
        '/main',
        'main\\x',
        'main~1',
        'main^',
        'main^{}',
        'main@{0}',
        'main:x',
        'ma in',
        'main\n',
        'main\u0000',
        'm\u00e4in',
        'main*',
        'main?',
        'main[0]'
      ]) {
        expect(isValidRevisionName(rev), show(rev)).to.equal(false)
      }
    })

    it('rejects names that do not start with a letter or digit', () => {
      for (const rev of ['', '.', '.hidden', '-x', '_x']) {
        expect(isValidRevisionName(rev), rev).to.equal(false)
      }
    })

    it('rejects non-strings', () => {
      for (const v of NOT_STRINGS)
        expect(isValidRevisionName(v), String(v)).to.equal(false)
    })
  })

  describe('repoFolderName', () => {
    it("maps owner/name to huggingface_hub's 'models--{owner}--{name}'", () => {
      expect(repoFolderName('org/name')).to.equal('models--org--name')
      expect(repoFolderName('Qwen/Qwen3.8-27B-FP8')).to.equal(
        'models--Qwen--Qwen3.8-27B-FP8'
      )
      expect(repoFolderName('Comfy-Org/Qwen-Image_ComfyUI')).to.equal(
        'models--Comfy-Org--Qwen-Image_ComfyUI'
      )
    })

    it('never maps two valid repo ids to the same folder', () => {
      const candidates = [
        'a-/b',
        'a/b-',
        'a/-b',
        'a-b/c',
        'a/b-c',
        'a.b/c',
        'a/b.c',
        'a_/b',
        'a/_b',
        'ab/c',
        'a/bc',
        'a-/-b',
        'a--/b',
        'a/--b',
        'A/b',
        'a/B',
        'a/b'
      ]
      const valid = candidates.filter((id) => isValidRepoId(id))
      expect(valid.length).to.be.at.least(10)
      const folders = valid.map((id) => repoFolderName(id))
      expect(new Set(folders).size).to.equal(valid.length)
    })

    it('always yields a single safe path segment for a valid id', () => {
      for (const id of [
        'org/name',
        'a-/b',
        'a/b-',
        'org.name/model.v2',
        `${'a'.repeat(96)}/${'b'.repeat(96)}`
      ]) {
        if (!isValidRepoId(id)) continue
        const folder = repoFolderName(id)
        expect(folder.startsWith('models--'), folder).to.equal(true)
        expect(folder).to.not.include('/')
        expect(folder).to.not.include('\\')
        expect(folder).to.not.equal('.')
        expect(folder).to.not.equal('..')
        expect(Buffer.byteLength(folder)).to.be.at.most(255)
      }
    })
  })

  describe('pathsOverlap', () => {
    const pairs: Array<[string, string, boolean]> = [
      // same path
      ['/data/a', '/data/a', true],
      ['/data/a/', '/data/a', true],
      ['/data/./a', '/data/a', true],
      ['/data/x/../a', '/data/a', true],
      // containment
      ['/data/a', '/data/a/b', true],
      ['/data/a', '/data/a/b/c/d', true],
      ['/data/x/../a', '/data/a/b', true],
      ['/', '/data/a', true],
      ['/', '/', true],
      // siblings that share a string prefix
      ['/data/a', '/data/ab', false],
      ['/data/a', '/data/a-b', false],
      ['/data/a', '/data/a.b', false],
      ['/data', '/data2', false],
      ['/srv/cache', '/srv/cache-old/x', false],
      // unrelated
      ['/data/a', '/data/b', false],
      ['/data/a/b', '/data/a/c', false],
      ['/data/a', '/srv/a', false]
    ]

    it('detects equal and nested paths, in both argument orders', () => {
      for (const [a, b, expected] of pairs) {
        expect(pathsOverlap(a, b), `${a} vs ${b}`).to.equal(expected)
        expect(pathsOverlap(b, a), `${b} vs ${a}`).to.equal(expected)
      }
    })

    it('resolves relative paths against the working directory', () => {
      const cwd = process.cwd()
      expect(pathsOverlap('mc-rel-dir', path.join(cwd, 'mc-rel-dir', 'sub'))).to.equal(
        true
      )
      expect(pathsOverlap(path.join(cwd, 'mc-rel-dir'), 'mc-rel-dir')).to.equal(true)
      expect(pathsOverlap('mc-rel-dir', path.join(cwd, 'mc-rel-dir2'))).to.equal(false)
      expect(pathsOverlap('.', cwd)).to.equal(true)
      expect(pathsOverlap('mc-rel-dir', cwd)).to.equal(true)
    })
  })

  describe('isValidRepoFilePath', () => {
    it('accepts repo-relative paths as the Hub lists them', () => {
      for (const p of [
        'config.json',
        'split_files/vae/qwen_image_vae.safetensors',
        'model-00001-of-00002.safetensors',
        '.gitattributes',
        'a/.hidden/b',
        'name with spaces.json',
        'C:/x.bin',
        '\u65e5\u672c\u8a9e/\u00fc\u00f1.safetensors',
        'emoji-\ud83d\ude00.txt'
      ]) {
        expect(isValidRepoFilePath(p), p).to.equal(true)
      }
    })

    it('accepts segments that merely contain dots', () => {
      for (const p of ['...', '.a', 'a.', 'a..b', '..a', '.../x', 'x/...', 'a/..b/c']) {
        expect(isValidRepoFilePath(p), p).to.equal(true)
      }
    })

    it('rejects empty, absolute and backslash paths', () => {
      for (const p of [
        '',
        '/',
        '/config.json',
        '//x',
        'a\\b.json',
        'C:\\x.bin',
        '\\\\server\\share\\x',
        'a/b\\..\\c'
      ]) {
        expect(isValidRepoFilePath(p), p).to.equal(false)
      }
    })

    it("rejects empty, '.' and '..' segments", () => {
      for (const p of [
        '.',
        '..',
        './a',
        '../a',
        'a/.',
        'a/..',
        'a/./b',
        'a/../b',
        'a//b',
        'a/',
        'a/b/',
        '../../etc/passwd'
      ]) {
        expect(isValidRepoFilePath(p), p).to.equal(false)
      }
    })

    it('rejects C0 control characters and DEL', () => {
      for (const p of [
        'a\u0000b',
        'a\tb',
        'a\nb',
        'a\rb',
        'a\u001bb',
        'a\u001fb',
        'a\u007fb',
        'config.json\n',
        '\u0001'
      ]) {
        expect(isValidRepoFilePath(p), show(p)).to.equal(false)
      }
    })

    it('allows a segment of exactly 255 UTF-8 bytes and rejects 256', () => {
      expect(isValidRepoFilePath('a'.repeat(255))).to.equal(true)
      expect(isValidRepoFilePath('a'.repeat(256))).to.equal(false)
      expect(isValidRepoFilePath(`${'a'.repeat(255)}/${'b'.repeat(255)}`)).to.equal(true)
      expect(isValidRepoFilePath(`dir/${'a'.repeat(256)}/x`)).to.equal(false)
      // bytes, not characters: 2-byte and 4-byte UTF-8
      expect(isValidRepoFilePath(`${'\u00e9'.repeat(127)}a`)).to.equal(true) // 255 bytes
      expect(isValidRepoFilePath('\u00e9'.repeat(128))).to.equal(false) // 128 chars, 256 bytes
      expect(isValidRepoFilePath(`${'\ud83d\ude00'.repeat(63)}abc`)).to.equal(true) // 255 bytes
      expect(isValidRepoFilePath('\ud83d\ude00'.repeat(64))).to.equal(false) // 256 bytes
    })

    it('rejects paths longer than 1024 characters', () => {
      const base = Array(5).fill('x'.repeat(200)).join('/')
      const p1024 = `${base}/${'y'.repeat(19)}`
      const p1025 = `${base}/${'y'.repeat(20)}`
      expect(p1024.length).to.equal(1024)
      expect(p1025.length).to.equal(1025)
      expect(isValidRepoFilePath(p1024)).to.equal(true)
      expect(isValidRepoFilePath(p1025)).to.equal(false)
    })

    it('rejects non-strings', () => {
      for (const v of NOT_STRINGS)
        expect(isValidRepoFilePath(v), String(v)).to.equal(false)
    })

    // Design: "no backslash/control chars". U+0080-U+009F are control characters (Unicode
    // category Cc) just like U+0000-U+001F and U+007F; U+009B is the 8-bit CSI.
    it('rejects C1 control characters (U+0080-U+009F)', () => {
      for (const p of ['a\u0080b', 'a\u0085b', 'a\u009bb', 'a\u009fb']) {
        expect(isValidRepoFilePath(p), show(p)).to.equal(false)
      }
      // the first non-control code point after the C1 block is still fine
      expect(isValidRepoFilePath('a\u00a0b')).to.equal(true)
    })
  })

  describe('safeJoin', () => {
    const root = path.resolve(
      '/srv/model-cache/public/hf/hub/models--org--name/snapshots',
      SHA
    )

    it('joins segments under the root', () => {
      expect(safeJoin(root, 'config.json')).to.equal(path.join(root, 'config.json'))
      expect(safeJoin(root, 'a', 'b', 'c.safetensors')).to.equal(
        path.join(root, 'a', 'b', 'c.safetensors')
      )
      expect(safeJoin(root, 'a/b')).to.equal(path.join(root, 'a', 'b'))
      expect(safeJoin(`${root}/`, 'a')).to.equal(path.join(root, 'a'))
    })

    it('normalizes inner dot segments that stay inside the root', () => {
      expect(safeJoin(root, 'a/b/../c')).to.equal(path.join(root, 'a', 'c'))
      expect(safeJoin(root, 'a', '.', 'b')).to.equal(path.join(root, 'a', 'b'))
    })

    it('refuses to resolve to the root itself', () => {
      for (const segments of [[], [''], ['.'], ['a', '..'], ['a/..']]) {
        expect(() => safeJoin(root, ...segments), JSON.stringify(segments)).to.throw(
          /refusing path outside the model cache/
        )
      }
    })

    it('refuses to leave the root', () => {
      const sibling = `../${path.basename(root)}x/file` // shares the root's string prefix
      for (const segments of [
        ['..'],
        ['../x'],
        ['a', '..', '..', 'x'],
        ['a/../../x'],
        ['/etc/passwd'],
        ['a', '/etc/passwd'],
        [sibling],
        ['..', path.basename(root)]
      ]) {
        expect(() => safeJoin(root, ...segments), JSON.stringify(segments)).to.throw(
          /refusing path outside the model cache/
        )
      }
    })

    it('names the refused segments in the error', () => {
      expect(() => safeJoin(root, '..', 'x')).to.throw(
        'refusing path outside the model cache: ../x'
      )
    })

    // A segment that only STARTS with '..' ('..foo', '...') is an ordinary name inside the
    // root; only '..' itself (or '../...') leaves it.
    it("accepts names that merely start with '..'", () => {
      for (const seg of ['..foo', '...', '..foo/bar.json']) {
        let joined = ''
        expect(
          () => {
            joined = safeJoin(root, seg)
          },
          `safeJoin(root, ${show(seg)})`
        ).to.not.throw()
        expect(joined, show(seg)).to.equal(path.join(root, seg))
      }
    })

    // ModelCacheStore.snapshotFile() is safeJoin(snapshotDir, ...file.split('/')) after
    // isValidRepoFilePath(file): every accepted Hub path must be linkable.
    it('joins every path isValidRepoFilePath accepts inside a snapshot dir', () => {
      for (const file of [
        'config.json',
        'a/b/c.safetensors',
        '.gitattributes',
        'a/..b',
        '...',
        '..foo',
        '..foo/bar.json',
        `${'x'.repeat(255)}/y`
      ]) {
        expect(isValidRepoFilePath(file), show(file)).to.equal(true)
        let joined = ''
        expect(
          () => {
            joined = safeJoin(root, ...file.split('/'))
          },
          `snapshot file ${show(file)}`
        ).to.not.throw()
        expect(path.relative(root, joined), show(file)).to.equal(
          path.join(...file.split('/'))
        )
      }
    })
  })
})
