import { expect } from 'chai'
import { toUtf8Bytes } from 'ethers'
import { peerIdFromString } from '@libp2p/peer-id'
import { KeyManager } from '../../../components/KeyManager/index.js'
import { getConfiguration } from '../../../utils/index.js'
import { STATUS_CHALLENGE_DOMAIN } from '../../../utils/crypt.js'

// OJ-03 (plan §14): the node answers a status challenge by signing a DOMAIN-SEPARATED digest with
// its libp2p IDENTITY key. ocean.js verifies with the public key extracted from the peerId. These
// tests prove the roundtrip and the domain separation locally.
describe('OJ-03 status identity challenge', () => {
  let keyManager: KeyManager
  let peerIdStr: string

  before(async () => {
    const config = await getConfiguration(true)
    keyManager = new KeyManager(config)
    peerIdStr = keyManager.getPeerIdString()
  })

  it('signWithIdentityKey output verifies against the peerId public key', async () => {
    const challenge = 'deadbeefcafe0001'
    const message = STATUS_CHALLENGE_DOMAIN + challenge
    const sig = await keyManager.signWithIdentityKey(toUtf8Bytes(message))
    const pub = peerIdFromString(peerIdStr).publicKey
    expect(pub).to.not.equal(undefined)
    const ok = await pub.verify(toUtf8Bytes(message), sig)
    expect(ok).to.equal(true)
  })

  it('domain separation: signature does NOT verify as a bare-challenge signature', async () => {
    const challenge = 'deadbeefcafe0002'
    const sig = await keyManager.signWithIdentityKey(
      toUtf8Bytes(STATUS_CHALLENGE_DOMAIN + challenge)
    )
    const pub = peerIdFromString(peerIdStr).publicKey
    const okBare = await pub.verify(toUtf8Bytes(challenge), sig)
    expect(okBare).to.equal(false)
  })

  it('a different challenge yields a different signature', async () => {
    const a = await keyManager.signWithIdentityKey(
      toUtf8Bytes(STATUS_CHALLENGE_DOMAIN + 'aaaa')
    )
    const b = await keyManager.signWithIdentityKey(
      toUtf8Bytes(STATUS_CHALLENGE_DOMAIN + 'bbbb')
    )
    expect(Buffer.from(a).toString('hex')).to.not.equal(Buffer.from(b).toString('hex'))
  })

  it('signWithIdentityKey is NOT the EVM signer (different key/scheme)', async () => {
    // The EVM signer signs an ethers message; its output must not verify as a libp2p signature.
    const challenge = 'feed0003'
    const message = STATUS_CHALLENGE_DOMAIN + challenge
    const evmSig = await keyManager.signMessage(message) // 0x... 65-byte r||s||v hex
    const pub = peerIdFromString(peerIdStr).publicKey
    let ok = false
    try {
      ok = await pub.verify(toUtf8Bytes(message), Buffer.from(evmSig.slice(2), 'hex'))
    } catch {
      ok = false
    }
    expect(ok).to.equal(false)
  })
})
