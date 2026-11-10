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
    // byte-for-byte: address + nonce + command + peerId + chainId + txId + nft
    expect(m).to.equal(
      consumer + nonce + PROTOCOL_COMMANDS.DECRYPT_DDO + peerIdA + chainId + txId1 + nft1
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

  it('local monotonic nonce (Date.now scheme) is non-decreasing across calls', () => {
    // The Indexer signer uses Date.now().toString() as the DECRYPT_DDO nonce. Assert the
    // property the verifier relies on: successive reads never go backwards.
    const first = Date.now()
    let last = first
    for (let i = 0; i < 1000; i++) {
      const n = Date.now()
      expect(n).to.be.at.least(last)
      last = n
    }
    expect(last).to.be.at.least(first)
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
