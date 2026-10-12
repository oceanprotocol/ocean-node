import { expect } from 'chai'
import { ethers } from 'ethers'
import { AdminCommandHandler } from '../../components/core/admin/adminHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'

// Minimal concrete subclass so we can exercise the (abstract) AdminCommandHandler
// logic directly. `handle` is intentionally a no-op; we only test
// validateTokenOrSignature here.
class TestAdminHandler extends AdminCommandHandler {
  handle(): Promise<P2PCommandResponse> {
    return Promise.resolve({ stream: null, status: { httpStatus: 200, error: null } })
  }
}

// A fake ethers ContractRunner. checkAddressOnAccessListWithSigner builds
// `new ethers.Contract(addr, abi, signer)` and calls `.balanceOf(address)`, a view
// call that ethers resolves through `runner.call(tx)`. By returning an ABI-encoded
// uint256 we control the reported balance without touching a real chain.
const coder = ethers.AbiCoder.defaultAbiCoder()
function fakeSignerWithBalance(balance: bigint): any {
  return {
    call: () => Promise.resolve(coder.encode(['uint256'], [balance]))
  }
}

// Lowercase (checksum-agnostic) contract + admin addresses so ethers.getAddress
// does not reject them.
const CONTRACT_ADDRESS = '0x6cfd3d3136c23f137a91180b2a55d731b73a6f26'
const ADMIN_ADDRESS = '0x0000000000000000000000000000000000000001'
const CHAIN_ID = '8453'

interface FakeNodeOptions {
  accessLists: { [chainId: string]: string[] }
  // blockchain returned by getBlockchain(); null simulates "no RPC configured"
  blockchain: { getSigner: () => Promise<any> } | null
}

function makeFakeOceanNode(
  options: FakeNodeOptions,
  blockchainCalls: number[]
): OceanNode {
  return {
    getAuth: () => ({
      validateAuthenticationOrToken: () => Promise.resolve({ valid: true, error: '' })
    }),
    getAdminAddresses: () => ({
      addresses: [] as string[],
      accessLists: options.accessLists
    }),
    getBlockchain: (chainId: number) => {
      blockchainCalls.push(chainId)
      return options.blockchain
    }
  } as unknown as OceanNode
}

describe('AdminCommandHandler access-list validation', () => {
  it('authorizes an admin that holds a token on the access-list contract', async () => {
    const blockchainCalls: number[] = []
    const node = makeFakeOceanNode(
      {
        accessLists: { [CHAIN_ID]: [CONTRACT_ADDRESS] },
        blockchain: { getSigner: () => Promise.resolve(fakeSignerWithBalance(1n)) }
      },
      blockchainCalls
    )
    const handler = new TestAdminHandler(node)

    const result = await handler.validateTokenOrSignature(
      ADMIN_ADDRESS,
      '1',
      '0xsignature',
      'someAdminCommand'
    )

    expect(result.valid).to.equal(true)
    // The fix must look up the chain with a numeric chainId (not pass the whole
    // array / a null signer to checkSingleCredential).
    expect(blockchainCalls).to.deep.equal([8453])
    expect(typeof blockchainCalls[0]).to.equal('number')
  })

  it('rejects an admin that holds no token on the access-list contract', async () => {
    const blockchainCalls: number[] = []
    const node = makeFakeOceanNode(
      {
        accessLists: { [CHAIN_ID]: [CONTRACT_ADDRESS] },
        blockchain: { getSigner: () => Promise.resolve(fakeSignerWithBalance(0n)) }
      },
      blockchainCalls
    )
    const handler = new TestAdminHandler(node)

    const result = await handler.validateTokenOrSignature(
      ADMIN_ADDRESS,
      '1',
      '0xsignature',
      'someAdminCommand'
    )

    expect(result.valid).to.equal(false)
    expect(result.error).to.contain('not on the allowed admins list')
    expect(blockchainCalls).to.deep.equal([8453])
  })

  it('skips gracefully (no throw) when no RPC is configured for the chain', async () => {
    const blockchainCalls: number[] = []
    const node = makeFakeOceanNode(
      {
        accessLists: { [CHAIN_ID]: [CONTRACT_ADDRESS] },
        // getBlockchain returns null -> chain has no RPC configured
        blockchain: null
      },
      blockchainCalls
    )
    const handler = new TestAdminHandler(node)

    const result = await handler.validateTokenOrSignature(
      ADMIN_ADDRESS,
      '1',
      '0xsignature',
      'someAdminCommand'
    )

    expect(result.valid).to.equal(false)
    expect(result.error).to.contain('not on the allowed admins list')
    expect(blockchainCalls).to.deep.equal([8453])
  })

  it('does NOT authorize when the configured contract address is empty', async () => {
    // Regression: an empty contract address makes checkAddressOnAccessListWithSigner
    // return true (falsy address => "no access list"), which would otherwise authorize
    // ANY authenticated caller as admin. The handler must fail closed.
    const blockchainCalls: number[] = []
    const node = makeFakeOceanNode(
      {
        accessLists: { [CHAIN_ID]: [''] },
        // A working signer that would return a non-zero balance if it were ever used.
        blockchain: { getSigner: () => Promise.resolve(fakeSignerWithBalance(1n)) }
      },
      blockchainCalls
    )
    const handler = new TestAdminHandler(node)

    const result = await handler.validateTokenOrSignature(
      ADMIN_ADDRESS,
      '1',
      '0xsignature',
      'someAdminCommand'
    )

    expect(result.valid).to.equal(false)
    expect(result.error).to.contain('not on the allowed admins list')
  })

  it('does NOT authorize when the configured contract address is malformed', async () => {
    const blockchainCalls: number[] = []
    const node = makeFakeOceanNode(
      {
        accessLists: { [CHAIN_ID]: ['not-an-address'] },
        blockchain: { getSigner: () => Promise.resolve(fakeSignerWithBalance(1n)) }
      },
      blockchainCalls
    )
    const handler = new TestAdminHandler(node)

    const result = await handler.validateTokenOrSignature(
      ADMIN_ADDRESS,
      '1',
      '0xsignature',
      'someAdminCommand'
    )

    expect(result.valid).to.equal(false)
    expect(result.error).to.contain('not on the allowed admins list')
  })

  it('continues to the next chain when one chain RPC throws', async () => {
    const blockchainCalls: number[] = []
    // Chain 1 (137) throws on getSigner (simulating RPC rate limit / downtime);
    // chain 2 (8453) authorizes. The admin must still be authorized.
    const throwingBlockchain = {
      getSigner: () => Promise.reject(new Error('RPC unavailable'))
    }
    const holderBlockchain = {
      getSigner: () => Promise.resolve(fakeSignerWithBalance(1n))
    }
    const node = {
      getAuth: () => ({
        validateAuthenticationOrToken: () => Promise.resolve({ valid: true, error: '' })
      }),
      getAdminAddresses: () => ({
        addresses: [] as string[],
        accessLists: { '137': [CONTRACT_ADDRESS], [CHAIN_ID]: [CONTRACT_ADDRESS] }
      }),
      getBlockchain: (chainId: number) => {
        blockchainCalls.push(chainId)
        return chainId === 137 ? throwingBlockchain : holderBlockchain
      }
    } as unknown as OceanNode
    const handler = new TestAdminHandler(node)

    const result = await handler.validateTokenOrSignature(
      ADMIN_ADDRESS,
      '1',
      '0xsignature',
      'someAdminCommand'
    )

    expect(result.valid).to.equal(true)
    // Both chains were visited: the throwing one did not abort the loop.
    expect(blockchainCalls).to.deep.equal([137, 8453])
  })

  it('rejects gracefully (no throw) when the only chain RPC throws', async () => {
    const blockchainCalls: number[] = []
    const node = makeFakeOceanNode(
      {
        accessLists: { [CHAIN_ID]: [CONTRACT_ADDRESS] },
        blockchain: {
          getSigner: () => Promise.reject(new Error('RPC unavailable'))
        }
      },
      blockchainCalls
    )
    const handler = new TestAdminHandler(node)

    const result = await handler.validateTokenOrSignature(
      ADMIN_ADDRESS,
      '1',
      '0xsignature',
      'someAdminCommand'
    )

    expect(result.valid).to.equal(false)
    expect(result.error).to.contain('not on the allowed admins list')
    expect(blockchainCalls).to.deep.equal([8453])
  })
})
