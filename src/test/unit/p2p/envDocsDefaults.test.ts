import { expect } from 'chai'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { ENV_TO_CONFIG_MAPPING } from '../../../utils/config/constants.js'
import { OceanNodeP2PConfigSchema } from '../../../utils/config/schemas.js'

/**
 * `docs/env.md` is the only place an operator learns what a knob does when it is left
 * alone, and nothing was checking it against the schema. Twelve of its stated P2P
 * defaults had drifted — four bind ports documented as `0` that are 9000—9003, an IPv6
 * bind address documented as loopback, `P2P_ANNOUNCE_PRIVATE` and
 * `P2P_ENABLE_CIRCUIT_RELAY_SERVER` documented as on when both are off, a bootstrap
 * timeout five times short, a bootstrap tag TTL that has no default at all, and a
 * one-entry announce filter that is now twelve entries.
 *
 * Each of those was a one-line text fix. This test is the part that matters, because the
 * drift is what recurs: the documented default and the schema's default are now compared
 * mechanically, so the next change to a default fails here rather than three months later
 * in somebody's deployment.
 *
 * Only machine-checkable claims participate — a documented default written as a
 * backticked number or `True`/`False` immediately after "Default:" or "Defaults to". A
 * key whose default is prose, a list, or a value the schema derives is skipped rather
 * than guessed at, and the count of what was checked is asserted so that a change which
 * quietly stops matching cannot make this test vacuous by covering nothing.
 */
describe('docs/env.md states the defaults the schema actually applies', () => {
  const docsPath = fileURLToPath(new URL('../../../../docs/env.md', import.meta.url))
  // The path is derived from this file's own location, not from input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const doc = readFileSync(docsPath, 'utf8')
  const defaults = OceanNodeP2PConfigSchema.parse({}) as Record<string, any>

  /** The key a doc line is about: `- \`P2P_FOO\`: …`. */
  const KEY = /^-\s*`(P2P_[A-Za-z0-9_]+)`/
  /** The value stated straight after "Default": `Default: \`123\`` / `Defaults to \`123\``. */
  const VALUE = /^Defaults?(?: to)?\s*:?\s*`([^`]+)`/

  function documentedDefaults(): Map<string, string> {
    const found = new Map<string, string>()
    for (const line of doc.split('\n')) {
      const key = KEY.exec(line.trim())
      if (key === null) continue
      // Scan forward to "Default" and match only from there. Deliberately not one regex
      // with a `.*?` in front of it: that shape backtracks badly on a long line and the
      // linter is right to object.
      const at = line.indexOf('Default')
      if (at === -1) continue
      const value = VALUE.exec(line.slice(at))
      if (value === null) continue
      // Only values that can be compared without interpreting prose.
      if (!/^-?\d+$/.test(value[1]) && !/^(True|False|true|false)$/.test(value[1]))
        continue
      if (!found.has(key[1])) found.set(key[1], value[1])
    }
    return found
  }

  it('agrees with the schema on every default it states as a plain value', () => {
    const mismatches: string[] = []
    let checked = 0

    for (const [envKey, documented] of documentedDefaults()) {
      const path = (ENV_TO_CONFIG_MAPPING as Record<string, string>)[envKey]
      if (path === undefined) continue
      const field = path.startsWith('p2pConfig.') ? path.slice('p2pConfig.'.length) : null
      if (field === null || !(field in defaults)) continue

      const actual = defaults[field]
      if (typeof actual !== 'number' && typeof actual !== 'boolean') continue

      checked++
      const expected =
        typeof actual === 'boolean' ? String(actual).toLowerCase() : String(actual)
      if (documented.toLowerCase() !== expected) {
        mismatches.push(`${envKey}: documented \`${documented}\`, schema \`${expected}\``)
      }
    }

    expect(mismatches, mismatches.join('\n')).to.deep.equal([])
    // Guards against the regex silently matching nothing after a docs reformat, which
    // would leave the assertion above trivially true.
    expect(
      checked,
      `too few documented defaults were checkable (checked ${checked})`
    ).to.be.at.least(25)
  })

  it('documents every P2P key the schema has a default for', () => {
    // A knob nobody can find is only marginally better than one that does not exist. The
    // check runs the other way round from the one above: from the schema to the docs.
    const undocumented: string[] = []
    for (const [envKey, path] of Object.entries(
      ENV_TO_CONFIG_MAPPING as Record<string, string>
    )) {
      if (!envKey.startsWith('P2P_') && !envKey.startsWith('BOOTSTRAP')) continue
      const field = path.startsWith('p2pConfig.') ? path.slice('p2pConfig.'.length) : null
      if (field === null || !(field in defaults)) continue
      if (!doc.includes(`\`${envKey}\``)) undocumented.push(envKey)
    }
    expect(undocumented, undocumented.join(', ')).to.deep.equal([])
  })
})
