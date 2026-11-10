import { assert } from 'chai'
import { AbiCoder, FallbackProvider, Interface, Signer, Wallet, getAddress } from 'ethers'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }
import { validateOrderTransaction } from '../../components/core/utils/validateOrders.js'

// Regression coverage for ON-01 (forged-order emitter).
//
// The attack: an attacker self-emits a fake OrderStarted (or OrderReused) from a contract
// they control, then wires a real reuseOrder on the genuine datatoken so that receipt.to
// points at the datatoken. Before the fix, validateOrderTransaction decoded the OrderStarted
// log purely by ABI signature and never checked WHICH contract emitted it, so the forgery
// was accepted and granted free access to a paid asset.
//
// After the fix, validateOrderTransaction binds every order event to the datatoken named by
// the DDO (datatokenAddress): an OrderStarted/OrderReused log whose emitter (log.address) is
// not that datatoken is ignored, so a forged event is rejected while a genuine one is
// accepted.
//
// Everything on-chain is faked in-process (no chain / Barge): the OrderStarted log is
// ABI-encoded with the real ERC20Template interface so it decodes exactly as on mainnet, and
// a fake ethers runner answers getERC721Address()/isDeployed().
const coder = AbiCoder.defaultAbiCoder()
const iface = new Interface(ERC20Template.abi)

const CONSUMER = getAddress(Wallet.createRandom().address) // order consumer / caller
const PAYER = getAddress(Wallet.createRandom().address) // order payer
const DATATOKEN = getAddress(Wallet.createRandom().address) // genuine datatoken (from DDO)
const NFT_ADDR = getAddress(Wallet.createRandom().address) // genuine data NFT (from DDO)
const ATTACKER_CONTRACT = getAddress(Wallet.createRandom().address) // forged event emitter
const PUBLISH_MARKET = getAddress(Wallet.createRandom().address)

const TX_ID = '0x' + 'ab'.repeat(32)
const REUSE_TX_ID = '0x' + 'ee'.repeat(32)
const BLOCK_HASH = '0x' + 'cd'.repeat(32)
const SERVICE_INDEX = 0
const SERVICE_TIMEOUT = 0 // never expires

function buildOrderStartedLog(emitter: string, consumer: string, payer: string): any {
  const encoded = iface.encodeEventLog('OrderStarted', [
    consumer,
    payer,
    1n, // amount
    BigInt(SERVICE_INDEX), // serviceIndex (args[3])
    BigInt(Math.floor(Date.now() / 1000)), // timestamp
    PUBLISH_MARKET,
    7n // blockNumber
  ])
  return { address: emitter, topics: [...encoded.topics], data: encoded.data }
}

function buildOrderReusedLog(emitter: string, originalTxId: string, caller: string): any {
  const encoded = iface.encodeEventLog('OrderReused', [
    originalTxId,
    caller,
    BigInt(Math.floor(Date.now() / 1000)),
    8n
  ])
  return { address: emitter, topics: [...encoded.topics], data: encoded.data }
}

// Fake ethers runner: answers getERC721Address() for the genuine datatoken and isDeployed()
// for the genuine NFT, and serves receipts out of the supplied map.
function buildRunner(receipts: Record<string, any>): any {
  const runner: any = {
    call: (tx: any) => {
      const to = (tx.to || '').toLowerCase()
      if (to === DATATOKEN.toLowerCase()) {
        return Promise.resolve(coder.encode(['address'], [NFT_ADDR]))
      }
      if (to === NFT_ADDR.toLowerCase()) {
        return Promise.resolve(coder.encode(['bool'], [true]))
      }
      return Promise.reject(new Error(`unexpected eth_call to ${to}`))
    },
    getTransactionReceipt: (txId: string) => Promise.resolve(receipts[txId] || null),
    getBlock: (_blockHash: string) =>
      Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) })
  }
  runner.provider = runner
  return runner
}

function runValidation(receipts: Record<string, any>) {
  const runner = buildRunner(receipts)
  return validateOrderTransaction(
    TX_ID,
    CONSUMER,
    runner as unknown as FallbackProvider,
    NFT_ADDR,
    DATATOKEN,
    SERVICE_INDEX,
    SERVICE_TIMEOUT,
    runner as unknown as Signer
  )
}

describe('validateOrderTransaction - forged order emitter (ON-01)', () => {
  it('rejects an OrderStarted forged by a non-datatoken contract', async () => {
    const receipts = {
      [TX_ID]: {
        to: DATATOKEN, // receipt.to points at the genuine datatoken (attacker-chosen)
        blockHash: BLOCK_HASH,
        logs: [buildOrderStartedLog(ATTACKER_CONTRACT, CONSUMER, PAYER)]
      }
    }
    const result = await runValidation(receipts)
    assert.isFalse(
      result.isValid,
      'an OrderStarted emitted by a contract other than the datatoken must be rejected'
    )
  })

  it('accepts a genuine OrderStarted emitted by the datatoken', async () => {
    const receipts = {
      [TX_ID]: {
        to: DATATOKEN,
        blockHash: BLOCK_HASH,
        logs: [buildOrderStartedLog(DATATOKEN, CONSUMER, PAYER)]
      }
    }
    const result = await runValidation(receipts)
    assert.isTrue(result.isValid, 'a genuine datatoken-emitted order must be accepted')
    assert.equal(result.message, 'Transaction is valid.')
  })

  it('rejects when a forged OrderStarted sits alongside the genuine datatoken tx (reuse attack)', async () => {
    // tx B is a genuine reuseOrder on the datatoken; tx A (the reused order) carries a forged
    // OrderStarted emitted by an attacker contract. The forged OrderStarted must be ignored.
    const receipts = {
      [TX_ID]: {
        to: DATATOKEN,
        blockHash: BLOCK_HASH,
        logs: [buildOrderReusedLog(DATATOKEN, REUSE_TX_ID, CONSUMER)]
      },
      [REUSE_TX_ID]: {
        to: ATTACKER_CONTRACT,
        blockHash: BLOCK_HASH,
        logs: [buildOrderStartedLog(ATTACKER_CONTRACT, CONSUMER, PAYER)]
      }
    }
    const result = await runValidation(receipts)
    assert.isFalse(
      result.isValid,
      'a reuse pointing at a forged OrderStarted must be rejected'
    )
  })

  it('rejects an OrderReused forged by a non-datatoken contract', async () => {
    // Even if the reused original is genuine, an OrderReused emitted by an attacker contract
    // must not be followed.
    const receipts = {
      [TX_ID]: {
        to: DATATOKEN,
        blockHash: BLOCK_HASH,
        logs: [buildOrderReusedLog(ATTACKER_CONTRACT, REUSE_TX_ID, CONSUMER)]
      },
      [REUSE_TX_ID]: {
        to: DATATOKEN,
        blockHash: BLOCK_HASH,
        logs: [buildOrderStartedLog(DATATOKEN, CONSUMER, PAYER)]
      }
    }
    const result = await runValidation(receipts)
    // The forged OrderReused is ignored; there is no genuine OrderReused and no genuine
    // OrderStarted in tx B, so validation fails closed.
    assert.isFalse(
      result.isValid,
      'an OrderReused emitted by a contract other than the datatoken must be ignored'
    )
  })

  it('accepts a genuine reuse: OrderReused and original OrderStarted both from the datatoken', async () => {
    const receipts = {
      [TX_ID]: {
        to: DATATOKEN,
        blockHash: BLOCK_HASH,
        logs: [buildOrderReusedLog(DATATOKEN, REUSE_TX_ID, CONSUMER)]
      },
      [REUSE_TX_ID]: {
        to: DATATOKEN,
        blockHash: BLOCK_HASH,
        logs: [buildOrderStartedLog(DATATOKEN, CONSUMER, PAYER)]
      }
    }
    const result = await runValidation(receipts)
    assert.isTrue(result.isValid, 'a fully genuine reuse chain must be accepted')
    assert.equal(result.message, 'Transaction is valid.')
  })
})
