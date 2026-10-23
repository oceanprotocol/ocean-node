import { assert } from 'chai'
import { AbiCoder, FallbackProvider, Interface, Signer, Wallet, getAddress } from 'ethers'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }
import { validateOrderTransaction } from '../../components/core/utils/validateOrders.js'

// Unit coverage for the compute order-authorization fix (Option B / env-AND).
//
// validateOrderTransaction now takes an optional trailing `payerAddress`:
//   - when provided (compute path): the OrderStarted event must have
//     consumer(args[0]) === userAddress AND payer(args[1]) === payerAddress
//   - when omitted (download path): the original position-agnostic OR is kept
//     (userAddress === consumer OR userAddress === payer).
//
// The on-chain calls are faked entirely in-process (no chain / Barge needed):
//   - the OrderStarted log is ABI-encoded with the real ERC20Template interface so
//     fetchEventFromTransaction()/Interface.parseLog() decode it exactly as on mainnet,
//   - the datatoken contract's getERC721Address() and the DataNFT's isDeployed() are
//     answered by a fake ethers ContractRunner (an object exposing `call`), which is all
//     ethers needs to resolve a read call and decode its result.
const coder = AbiCoder.defaultAbiCoder()
const iface = new Interface(ERC20Template.abi)

// Stable, correctly-checksummed addresses used across the cases.
const ENV = getAddress(Wallet.createRandom().address) // order consumer = this env/node
const CALLER = getAddress(Wallet.createRandom().address) // signature-verified caller
const OTHER = getAddress(Wallet.createRandom().address) // some third wallet
const ERC20_ADDR = getAddress(Wallet.createRandom().address) // datatoken / receipt.to
const NFT_ADDR = getAddress(Wallet.createRandom().address) // DataNFT (erc721)
const PUBLISH_MARKET = getAddress(Wallet.createRandom().address)

const TX_ID = '0x' + 'ab'.repeat(32)
const BLOCK_HASH = '0x' + 'cd'.repeat(32)
const SERVICE_INDEX = 0
const SERVICE_TIMEOUT = 0 // never expires

function buildOrderStartedLog(consumer: string, payer: string): any {
  const encoded = iface.encodeEventLog('OrderStarted', [
    consumer,
    payer,
    1n, // amount
    BigInt(SERVICE_INDEX), // serviceIndex (args[3])
    BigInt(Math.floor(Date.now() / 1000)), // timestamp
    PUBLISH_MARKET,
    7n // blockNumber
  ])
  return { topics: [...encoded.topics], data: encoded.data }
}

// Fake ethers runner (works as both provider and signer runner): answers the two read
// calls validateOrderTransaction makes via `new Contract(...)`.
function buildRunner(): any {
  const runner: any = {
    call: (tx: any) => {
      const to = (tx.to || '').toLowerCase()
      if (to === ERC20_ADDR.toLowerCase()) {
        // datatokenContract.getERC721Address()
        return Promise.resolve(coder.encode(['address'], [NFT_ADDR]))
      }
      if (to === NFT_ADDR.toLowerCase()) {
        // ERC721Contract.isDeployed(datatoken)
        return Promise.resolve(coder.encode(['bool'], [true]))
      }
      return Promise.reject(new Error(`unexpected eth_call to ${to}`))
    },
    getTransactionReceipt: (_txId: string) =>
      Promise.resolve({
        to: ERC20_ADDR,
        blockHash: BLOCK_HASH,
        logs: [currentLog]
      }),
    getBlock: (_blockHash: string) =>
      Promise.resolve({
        timestamp: Math.floor(Date.now() / 1000)
      })
  }
  runner.provider = runner
  return runner
}

// The log the fake receipt will carry for the current case (set per test).
let currentLog: any

function runValidation(
  userAddress: string,
  payerAddress?: string
): ReturnType<typeof validateOrderTransaction> {
  const runner = buildRunner()
  return validateOrderTransaction(
    TX_ID,
    userAddress,
    runner as unknown as FallbackProvider,
    NFT_ADDR,
    ERC20_ADDR,
    SERVICE_INDEX,
    SERVICE_TIMEOUT,
    runner as unknown as Signer,
    payerAddress
  )
}

describe('validateOrderTransaction - compute order payer binding (Option B)', () => {
  describe('with payerAddress provided (compute path: env-AND)', () => {
    it('rejects an order whose consumer === env but payer !== caller (the reuse vuln)', async () => {
      currentLog = buildOrderStartedLog(ENV, OTHER) // paid by someone else
      const result = await runValidation(ENV, CALLER)
      assert.isFalse(result.isValid, 'foreign-payer order must be rejected')
    })

    it('accepts an order where consumer === env AND payer === caller', async () => {
      currentLog = buildOrderStartedLog(ENV, CALLER)
      const result = await runValidation(ENV, CALLER)
      assert.isTrue(result.isValid, 'own order for this env must be accepted')
      assert.equal(result.message, 'Transaction is valid.')
    })

    it('rejects an order where consumer !== env even if payer === caller', async () => {
      currentLog = buildOrderStartedLog(OTHER, CALLER)
      const result = await runValidation(ENV, CALLER)
      assert.isFalse(
        result.isValid,
        'order whose consumer is not this env is unusable and must be rejected'
      )
    })
  })

  describe('without payerAddress (download path: position-agnostic OR preserved)', () => {
    it('accepts when caller === consumer (payer is someone else)', async () => {
      currentLog = buildOrderStartedLog(CALLER, OTHER)
      const result = await runValidation(CALLER)
      assert.isTrue(result.isValid, 'caller as consumer must still be accepted')
    })

    it('accepts when caller === payer (consumer is someone else)', async () => {
      currentLog = buildOrderStartedLog(OTHER, CALLER)
      const result = await runValidation(CALLER)
      assert.isTrue(result.isValid, 'caller as payer must still be accepted')
    })

    it('rejects when caller is neither consumer nor payer', async () => {
      currentLog = buildOrderStartedLog(ENV, OTHER)
      const result = await runValidation(CALLER)
      assert.isFalse(result.isValid, 'caller unrelated to the order must be rejected')
    })
  })
})

describe('validateOrderTransaction - OrderReused path (compute payer binding)', () => {
  // The submitted tx is an OrderReused tx (sent by whoever reuses the order). The
  // validator follows args[0] (orderTxId) to the ORIGINAL OrderStarted tx and checks
  // consumer/payer there. OrderReused.caller is NOT consulted.
  const REUSE_TX_ID = '0x' + 'ee'.repeat(32)
  const ORIGINAL_TX_ID = TX_ID
  const PAYER_A = CALLER // original payer / legitimate caller
  const CALLER_B = OTHER // attacker reusing A's order

  function buildOrderReusedLog(originalTxId: string, reuseCaller: string): any {
    const encoded = iface.encodeEventLog('OrderReused', [
      originalTxId,
      reuseCaller,
      BigInt(Math.floor(Date.now() / 1000)),
      8n
    ])
    return { topics: [...encoded.topics], data: encoded.data }
  }

  function runReused(
    originalLog: any,
    reuseCaller: string,
    userAddress: string,
    payerAddress: string
  ): ReturnType<typeof validateOrderTransaction> {
    const runner = buildRunner()
    const receipts: Record<string, any> = {
      [REUSE_TX_ID]: {
        to: ERC20_ADDR,
        blockHash: BLOCK_HASH,
        logs: [buildOrderReusedLog(ORIGINAL_TX_ID, reuseCaller)]
      },
      [ORIGINAL_TX_ID]: { to: ERC20_ADDR, blockHash: BLOCK_HASH, logs: [originalLog] }
    }
    runner.getTransactionReceipt = (txId: string) =>
      Promise.resolve(receipts[txId] || null)
    return validateOrderTransaction(
      REUSE_TX_ID,
      userAddress,
      runner as unknown as FallbackProvider,
      NFT_ADDR,
      ERC20_ADDR,
      SERVICE_INDEX,
      SERVICE_TIMEOUT,
      runner as unknown as Signer,
      payerAddress
    )
  }

  it('rejects: B submits an OrderReused tx pointing at an order originally paid by A', async () => {
    const original = buildOrderStartedLog(ENV, PAYER_A)
    // caller B (verified caller, payerAddress=B) reuses A's order; even though the
    // reuse tx was sent by B, the original payer is A -> must be rejected
    const result = await runReused(original, CALLER_B, ENV, CALLER_B)
    assert.isFalse(result.isValid, 'reuse of a foreign-paid order must be rejected')
  })

  it("accepts: A submits an OrderReused tx pointing at A's own original order", async () => {
    const original = buildOrderStartedLog(ENV, PAYER_A)
    const result = await runReused(original, PAYER_A, ENV, PAYER_A)
    assert.isTrue(result.isValid, 'own reused order must be accepted')
    assert.equal(result.message, 'Transaction is valid.')
  })

  it('accepts: reuse tx sent by B does not matter when verified caller is the original payer A', async () => {
    // reuse tx sent by B, but A is the verified caller: still bound to original payer A,
    // so this is accepted for A (the reuse sender is irrelevant to authorization)
    const original = buildOrderStartedLog(ENV, PAYER_A)
    const result = await runReused(original, CALLER_B, ENV, PAYER_A)
    assert.isTrue(result.isValid, 'authorization depends only on original payer')
  })
})
