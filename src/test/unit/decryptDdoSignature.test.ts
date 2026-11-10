import { expect } from 'chai'
import { ethers } from 'ethers'
import { buildDecryptDDOSignatureMessage } from '../../utils/crypt.js'
import { verifyConsumerSignature } from '../../components/core/utils/nonceHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

// Reproduces KeyManager RawPrivateKeyProvider.signMessage so the test signs exactly what the
// Indexer signer would. verifyConsumerSignature accepts this via its messageHashBytes branch.
async function signNodeMessage(
  wallet: ethers.BaseWallet,
  message: string
): Promise<string> {
  const messageHash = ethers.solidityPackedKeccak256(
    ['bytes'],
    [ethers.hexlify(ethers.toUtf8Bytes(message))]
  )
  return await wallet.signMessage(ethers.getBytes(messageHash))
}

// Minimal config: no supported networks, so the ERC-1271 fallback loop is a no-op and
// verification depends purely on the EOA signature over the bound message.
const EMPTY_CONFIG = { supportedNetworks: {} } as unknown as OceanNodeConfig

describe('ON-02 DECRYPT_DDO signature binding', () => {
  const wallet = ethers.Wallet.createRandom()
  const consumer = wallet.address
  const nonce = '1700000000000'
  const chainId = '8996'
  const peerIdA = '16Uiu2HAmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const peerIdB = '16Uiu2HAmBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  const txId1 = '0x' + '11'.repeat(32)
  const txId2 = '0x' + '22'.repeat(32)
  const nft1 = ethers.getAddress('0x' + 'aa'.repeat(20))
  const nft2 = ethers.getAddress('0x' + 'bb'.repeat(20))

  it('shared helper builds a deterministic, fully bound message', () => {
    const m = buildDecryptDDOSignatureMessage({
      decrypterAddress: consumer,
      nonce,
      issuerPeerId: peerIdA,
      chainId,
      txId: txId1,
      dataNftAddress: nft1
    })
    // byte-for-byte: address + nonce + command + peerId + chainId + txId + nft.
    // The nft address is bound in LOWER case so the message is casing-agnostic.
    expect(m).to.equal(
      consumer +
        nonce +
        PROTOCOL_COMMANDS.DECRYPT_DDO +
        peerIdA +
        chainId +
        txId1 +
        nft1.toLowerCase()
    )
    // differs when any binding field differs
    expect(m).to.not.equal(
      buildDecryptDDOSignatureMessage({
        decrypterAddress: consumer,
        nonce,
        issuerPeerId: peerIdB,
        chainId,
        txId: txId1,
        dataNftAddress: nft1
      })
    )
  })

  it('accepts a signature at the SAME peerId + resource it was minted for', async () => {
    const message = buildDecryptDDOSignatureMessage({
      decrypterAddress: consumer,
      nonce,
      issuerPeerId: peerIdA,
      chainId,
      txId: txId1,
      dataNftAddress: nft1
    })
    const signature = await signNodeMessage(wallet, message)
    const ok = await verifyConsumerSignature(
      consumer,
      nonce,
      signature,
      peerIdA,
      PROTOCOL_COMMANDS.DECRYPT_DDO,
      EMPTY_CONFIG,
      chainId,
      { txId: txId1, dataNftAddress: nft1 }
    )
    expect(ok).to.equal(true)
  })

  it('REJECTS a signature minted for peerId A when verified at peerId B (cross-node replay)', async () => {
    const message = buildDecryptDDOSignatureMessage({
      decrypterAddress: consumer,
      nonce,
      issuerPeerId: peerIdA,
      chainId,
      txId: txId1,
      dataNftAddress: nft1
    })
    const signature = await signNodeMessage(wallet, message)
    const ok = await verifyConsumerSignature(
      consumer,
      nonce,
      signature,
      peerIdB, // different destination node
      PROTOCOL_COMMANDS.DECRYPT_DDO,
      EMPTY_CONFIG,
      chainId,
      { txId: txId1, dataNftAddress: nft1 }
    )
    expect(ok).to.equal(false)
  })

  it('REJECTS a signature for (txId1, nft1) when verified for (txId2, nft2) (cross-resource replay)', async () => {
    const message = buildDecryptDDOSignatureMessage({
      decrypterAddress: consumer,
      nonce,
      issuerPeerId: peerIdA,
      chainId,
      txId: txId1,
      dataNftAddress: nft1
    })
    const signature = await signNodeMessage(wallet, message)
    const okTx = await verifyConsumerSignature(
      consumer,
      nonce,
      signature,
      peerIdA,
      PROTOCOL_COMMANDS.DECRYPT_DDO,
      EMPTY_CONFIG,
      chainId,
      { txId: txId2, dataNftAddress: nft1 }
    )
    expect(okTx).to.equal(false)
    const okNft = await verifyConsumerSignature(
      consumer,
      nonce,
      signature,
      peerIdA,
      PROTOCOL_COMMANDS.DECRYPT_DDO,
      EMPTY_CONFIG,
      chainId,
      { txId: txId1, dataNftAddress: nft2 }
    )
    expect(okNft).to.equal(false)
  })

  it('local monotonic nonce scheme is STRICTLY increasing even within one millisecond', () => {
    // The Indexer signer (BaseProcessor.getLocalNonce) hands out max(now, last + 1) from a
    // per-processor high-water mark. Mirror that algorithm and assert the property the verifier
    // relies on: successive nonces strictly increase, even when the clock does not advance (same
    // millisecond) or steps backwards — the cases plain Date.now() could not guarantee.
    let last = 0
    const nextNonce = (now: number) => {
      last = Math.max(now, last + 1)
      return last
    }
    // Clock frozen, then jumping backwards: nonces still strictly increase.
    const frozen = 1_700_000_000_000
    let prev = nextNonce(frozen)
    for (const now of [frozen, frozen, frozen - 5, frozen - 100, frozen + 1]) {
      const n = nextNonce(now)
      expect(n).to.be.greaterThan(prev)
      prev = n
    }
  })

  it('accepts a signature that bound the NFT address in LOWER case (casing tolerance)', async () => {
    // A client (or SDK) may sign the message with the NFT address lower-cased, while the node
    // checksum-normalizes it on ingress. Because the shared helper lower-cases dataNftAddress on
    // both sides, the signature still verifies when the verifier is handed the CHECKSUMMED form.
    const lowerNft = nft1.toLowerCase()
    const message = buildDecryptDDOSignatureMessage({
      decrypterAddress: consumer,
      nonce,
      issuerPeerId: peerIdA,
      chainId,
      txId: txId1,
      dataNftAddress: lowerNft
    })
    const signature = await signNodeMessage(wallet, message)
    // Verifier receives the checksummed address (as it would after ingress normalization).
    const ok = await verifyConsumerSignature(
      consumer,
      nonce,
      signature,
      peerIdA,
      PROTOCOL_COMMANDS.DECRYPT_DDO,
      EMPTY_CONFIG,
      chainId,
      { txId: txId1, dataNftAddress: nft1 }
    )
    expect(ok).to.equal(true)
  })

  it('REGRESSION: non-DECRYPT_DDO commands verify with the unchanged message, ignoring binding fields', async () => {
    // Legacy message: consumer + nonce + command + issuerPeerId (issuerPeerId '' for download)
    const legacyMessage = consumer + nonce + PROTOCOL_COMMANDS.DOWNLOAD + ''
    const signature = await signNodeMessage(wallet, legacyMessage)
    // Verifies without binding fields...
    const okPlain = await verifyConsumerSignature(
      consumer,
      nonce,
      signature,
      '',
      PROTOCOL_COMMANDS.DOWNLOAD,
      EMPTY_CONFIG
    )
    expect(okPlain).to.equal(true)
    // ...and the binding fields must NOT be appended for a non-decrypt command, so the same
    // signature still verifies even when extraSignedFields are present.
    const okWithExtra = await verifyConsumerSignature(
      consumer,
      nonce,
      signature,
      '',
      PROTOCOL_COMMANDS.DOWNLOAD,
      EMPTY_CONFIG,
      null,
      { txId: txId1, dataNftAddress: nft1 }
    )
    expect(okWithExtra).to.equal(true)
  })
})
