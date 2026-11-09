import { expect } from 'chai'
import sinon from 'sinon'
import { AbiCoder, Interface, parseUnits } from 'ethers'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20Template.sol/ERC20Template.json' with { type: 'json' }
import { CollectFeesHandler } from '../../components/core/admin/collectFeesHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { AdminCollectFeesCommand } from '../../@types/commands.js'

// These are pure unit tests: no chain, no RPC. We feed the handler a fake
// `OceanNode` whose blockchain hands back a fake ethers ContractRunner. The
// runner answers `decimals()` / `balanceOf()` via `call` and captures the
// `transfer(dest, amount)` arguments via `sendTransaction`, so we can assert on
// exactly how many base units the handler tried to move — the thing the
// non-18-decimal bug got wrong.

const coder = AbiCoder.defaultAbiCoder()
const iface = new Interface(ERC20Template.abi)

const WALLET_ADDRESS = '0x0000000000000000000000000000000000000003'
const DESTINATION_ADDRESS = '0x0000000000000000000000000000000000000002'
// Lowercase so ethers.getAddress / isAddress accept it without checksum issues.
const USDC_ADDRESS = '0x6cfd3d3136c23f137a91180b2a55d731b73a6f26'
const CHAIN_ID = 8996
const TX_HASH = '0x' + 'ab'.repeat(32)

interface Captured {
  name?: string
  amount?: string
  to?: string
}

// Build a fake ethers runner for `new Contract(addr, ERC20Template.abi, runner)`.
// `decimals` and `balanceOf` are view calls routed through `runner.call`; the
// nonpayable `transfer` goes through `runner.sendTransaction`, and ethers' own
// ContractTransactionResponse.wait() then re-reads the receipt via
// `runner.provider.getTransactionReceipt`, so we supply that too.
function makeFakeRunner(decimals: number, balance: bigint, captured: Captured): any {
  const provider = {
    getBalance: () => Promise.resolve(balance),
    getTransactionReceipt: () =>
      Promise.resolve({
        status: 1,
        hash: TX_HASH,
        logs: [],
        blockNumber: 1,
        blockHash: '0x' + 'cd'.repeat(32),
        index: 0,
        gasUsed: 21000n,
        cumulativeGasUsed: 21000n,
        gasPrice: 1n,
        type: 2,
        from: WALLET_ADDRESS,
        to: DESTINATION_ADDRESS,
        contractAddress: null,
        logsBloom: '0x' + '00'.repeat(256),
        root: null
      })
  }
  return {
    provider,
    call: (tx: any) => {
      const fn = iface.getFunction(tx.data.slice(0, 10))
      if (fn.name === 'decimals') {
        return Promise.resolve(coder.encode(['uint8'], [decimals]))
      }
      if (fn.name === 'balanceOf') {
        return Promise.resolve(coder.encode(['uint256'], [balance]))
      }
      return Promise.resolve('0x')
    },
    sendTransaction: (tx: any) => {
      const parsed = iface.parseTransaction({ data: tx.data })
      captured.name = parsed.name
      captured.to = String(parsed.args[0])
      captured.amount = String(parsed.args[1])
      return Promise.resolve({
        hash: TX_HASH,
        wait: () => Promise.resolve({ status: 1 })
      })
    }
  }
}

function makeFakeOceanNode(runner: any): OceanNode {
  const blockchain = {
    getProvider: () => Promise.resolve(runner.provider),
    getWallet: () => ({ getAddress: () => Promise.resolve(WALLET_ADDRESS) }),
    getSigner: () => Promise.resolve(runner)
  }
  return {
    getConfig: () => ({ supportedNetworks: { [CHAIN_ID]: { chainId: CHAIN_ID } } }),
    getKeyManager: () => ({ getPeerIdString: () => 'fake-peer-id' }),
    checkSupportedChainId: () => ({
      validation: true,
      networkRpc: 'http://localhost:8545'
    }),
    getBlockchain: () => blockchain
  } as unknown as OceanNode
}

function makeTask(tokenAmount: number): AdminCollectFeesCommand {
  return {
    command: PROTOCOL_COMMANDS.COLLECT_FEES,
    chainId: CHAIN_ID,
    tokenAddress: USDC_ADDRESS,
    tokenAmount,
    destinationAddress: DESTINATION_ADDRESS,
    node: undefined,
    // auth fields are irrelevant here: validate() is stubbed below
    nonce: '1',
    address: WALLET_ADDRESS,
    signature: '0xsignature'
  } as unknown as AdminCollectFeesCommand
}

describe('CollectFeesHandler ERC20 decimals scaling', () => {
  afterEach(() => sinon.restore())

  it('scales the amount by the token decimals for a 6-decimal token (USDC)', async () => {
    const captured: Captured = {}
    // 5 USDC on-chain == 5 * 10^6 base units. With the old `parseUnits(amount,
    // 'ether')` this request would be read as 5 * 10^18 and rejected as
    // "Amount too high to transfer!".
    const balance = parseUnits('5', 6)
    const runner = makeFakeRunner(6, balance, captured)
    const node = makeFakeOceanNode(runner)
    const handler = new CollectFeesHandler(node)
    sinon.stub(handler, 'validate').resolves({ valid: true })

    const response = await handler.handle(makeTask(5))

    expect(response.status.httpStatus).to.equal(200)
    expect(captured.name).to.equal('transfer')
    expect(captured.to.toLowerCase()).to.equal(DESTINATION_ADDRESS)
    // The crux: 5 USDC => 5_000_000 base units, NOT 5 * 10^18.
    expect(captured.amount).to.equal(parseUnits('5', 6).toString())
    expect(captured.amount).to.equal('5000000')
    expect(captured.amount).to.not.equal(parseUnits('5', 18).toString())
  })

  it('does not reject a within-balance withdrawal for a 6-decimal token', async () => {
    const captured: Captured = {}
    // Balance exactly equals the requested amount in real units.
    const runner = makeFakeRunner(6, parseUnits('5', 6), captured)
    const handler = new CollectFeesHandler(makeFakeOceanNode(runner))
    sinon.stub(handler, 'validate').resolves({ valid: true })

    const response = await handler.handle(makeTask(5))

    expect(response.status.httpStatus).to.equal(200)
    expect(response.status.error).to.be.oneOf([undefined, null])
  })

  it('rejects (and sends no transfer) when the amount exceeds a 6-decimal balance', async () => {
    const captured: Captured = {}
    // Wallet holds 4 USDC but the admin asks for 5 USDC. This must be rejected
    // on the real-units comparison, and crucially NOT because of a 10^18 vs 10^6
    // scale mismatch.
    const runner = makeFakeRunner(6, parseUnits('4', 6), captured)
    const handler = new CollectFeesHandler(makeFakeOceanNode(runner))
    sinon.stub(handler, 'validate').resolves({ valid: true })

    const response = await handler.handle(makeTask(5))

    expect(response.status.httpStatus).to.not.equal(200)
    expect(response.status.error).to.contain('Amount too high to transfer')
    // No transfer was ever submitted.
    expect(captured.name).to.equal(undefined)
  })

  it('still scales correctly for an 18-decimal token (no regression)', async () => {
    const captured: Captured = {}
    const runner = makeFakeRunner(18, parseUnits('5', 18), captured)
    const handler = new CollectFeesHandler(makeFakeOceanNode(runner))
    sinon.stub(handler, 'validate').resolves({ valid: true })

    const response = await handler.handle(makeTask(5))

    expect(response.status.httpStatus).to.equal(200)
    expect(captured.amount).to.equal(parseUnits('5', 18).toString())
  })
})
