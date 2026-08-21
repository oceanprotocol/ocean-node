import { expect } from 'chai'
import { humanizeHex } from '../../utils/humanHash.js'

// These values were captured from the `humanhash@1.0.4` package this module replaced.
// friendlyName is part of the public node status response, so operators and monitoring
// identify a node by it - if any of these change, every node in the fleet is renamed.
// Treat a failure here as a compatibility break, not a test to update.
const GOLDEN: Array<[string, number, string, string]> = [
  // a real compressed secp256k1 node public key
  [
    '038b1b222564fb8302e9acfa4bcd60060de03ae479fcbed38fe21e45cd39ddb3fe',
    4,
    '-',
    'mexico-high-tennessee-gee'
  ],
  [
    '020000000000000000000000000000000000000000000000000000000000000001',
    4,
    '-',
    'alanine-ack-ack-alabama'
  ],
  [
    '03ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    4,
    '-',
    'yankee-ack-ack-ack'
  ],
  ['deadbeefdeadbeefdeadbeefdeadbeef', 4, '-', 'carpet-carpet-carpet-carpet'],
  // uppercase parses the same
  ['DEADBEEFDEADBEEFDEADBEEFDEADBEEF', 4, '-', 'carpet-carpet-carpet-carpet'],
  ['deadbeef', 4, '-', 'thirteen-pasta-sad-violet'],
  ['deadbeef', 2, '-', 'kitten-fruit'],
  [
    'deadbeefdeadbeefdeadbeefdeadbeef',
    8,
    '_',
    'kitten_fruit_kitten_fruit_kitten_fruit_kitten_fruit'
  ],
  // odd number of hex chars: the trailing character becomes a byte of its own
  ['abcde', 2, '-', 'papa-seventeen'],
  ['00112233445566778899aabbccddeeff', 4, '::', 'ack::ack::ack::ack']
]

describe('humanizeHex', () => {
  it('reproduces the humanhash output it replaced', () => {
    for (const [hex, words, separator, expected] of GOLDEN) {
      expect(humanizeHex(hex, words, separator)).to.equal(expected)
    }
  })

  it('defaults to 4 dash-separated words', () => {
    expect(humanizeHex('deadbeefdeadbeefdeadbeefdeadbeef')).to.equal(
      'carpet-carpet-carpet-carpet'
    )
  })

  it('is deterministic', () => {
    const key = '038b1b222564fb8302e9acfa4bcd60060de03ae479fcbed38fe21e45cd39ddb3fe'
    expect(humanizeHex(key)).to.equal(humanizeHex(key))
  })

  it('always emits the requested number of words', () => {
    const key = '038b1b222564fb8302e9acfa4bcd60060de03ae479fcbed38fe21e45cd39ddb3fe'
    for (const words of [1, 2, 3, 4, 5, 8, 16]) {
      expect(humanizeHex(key, words).split('-')).to.have.lengthOf(words)
    }
  })

  it('only ever emits words from the wordlist', () => {
    // 33 bytes folded to 4 must land inside 0..255 for every input
    for (let byte = 0; byte < 256; byte++) {
      const hex = byte.toString(16).padStart(2, '0').repeat(33)
      for (const word of humanizeHex(hex).split('-')) {
        expect(word).to.match(/^[a-z]+$/)
      }
    }
  })

  it('throws when there are fewer bytes than requested words', () => {
    expect(() => humanizeHex('ab', 4)).to.throw('Fewer input bytes than requested output')
  })

  it('rejects a wordlist that is not exactly 256 words', () => {
    expect(() => humanizeHex('deadbeef', 4, '-', ['a', 'b'])).to.throw(
      'Wordlist must have exactly 256 items'
    )
  })
})
