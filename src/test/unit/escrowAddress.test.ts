import { expect } from 'chai'
import { ethers } from 'ethers'
import { getEscrowAddressForChain } from '../../utils/address.js'
import { Escrow } from '../../components/core/utils/escrow.js'
import { retrieveChunkEvents } from '../../components/Indexer/utils.js'
// processor.js first: importing a processor module directly trips the processors' import cycle
import '../../components/Indexer/processor.js'
import { EscrowEventProcessor } from '../../components/Indexer/processors/EscrowEventProcessor.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

// Addresses from the bundled ocean-contracts address file.
// Optimism: both Escrow and EnterpriseEscrow are deployed.
const CHAIN_WITH_ENTERPRISE = 10
const ESCROW_ON_OPTIMISM = '0x9497d1d64F2aFeBcd4f9916Eef3d9094E5Df962f'
const ENTERPRISE_ESCROW_ON_OPTIMISM = '0x7b0576CF01E868bce46cca91b2a8E674141b0355'
// Base: only Escrow is deployed.
const CHAIN_WITHOUT_ENTERPRISE = 8453
const ESCROW_ON_BASE = '0x09c9a4010E106b9673DcD58AB021a2C84457f323'
const UNKNOWN_CHAIN = 999999999

describe('Escrow contract selection (IS_ENTERPRISE)', () => {
  describe('getEscrowAddressForChain', () => {
    it('returns Escrow when not enterprise, even where EnterpriseEscrow is deployed', () => {
      expect(getEscrowAddressForChain(CHAIN_WITH_ENTERPRISE)).to.equal(ESCROW_ON_OPTIMISM)
      expect(getEscrowAddressForChain(CHAIN_WITH_ENTERPRISE, false)).to.equal(
        ESCROW_ON_OPTIMISM
      )
    })

    it('returns EnterpriseEscrow for an enterprise node', () => {
      expect(getEscrowAddressForChain(CHAIN_WITH_ENTERPRISE, true)).to.equal(
        ENTERPRISE_ESCROW_ON_OPTIMISM
      )
    })

    it('falls back to Escrow for an enterprise node where EnterpriseEscrow is missing', () => {
      expect(getEscrowAddressForChain(CHAIN_WITHOUT_ENTERPRISE, true)).to.equal(
        ESCROW_ON_BASE
      )
    })

    it('returns null on a chain without any escrow', () => {
      expect(getEscrowAddressForChain(UNKNOWN_CHAIN)).to.equal(null)
      expect(getEscrowAddressForChain(UNKNOWN_CHAIN, true)).to.equal(null)
    })
  })

  it('core Escrow pays through the contract matching the toggle', () => {
    const community = new Escrow({} as any, 3600, {} as any, null)
    const enterprise = new Escrow({} as any, 3600, {} as any, null, true)
    expect(community.getEscrowContractAddressForChain(CHAIN_WITH_ENTERPRISE)).to.equal(
      ESCROW_ON_OPTIMISM
    )
    expect(enterprise.getEscrowContractAddressForChain(CHAIN_WITH_ENTERPRISE)).to.equal(
      ENTERPRISE_ESCROW_ON_OPTIMISM
    )
  })

  it('indexer escrow processor tracks the same contract as core Escrow', () => {
    const processorAddress = (isEnterprise: boolean) =>
      (
        new EscrowEventProcessor(CHAIN_WITH_ENTERPRISE, {
          isEnterprise
        } as OceanNodeConfig) as any
      ).escrowAddress
    expect(processorAddress(false)).to.equal(ESCROW_ON_OPTIMISM)
    expect(processorAddress(true)).to.equal(ENTERPRISE_ESCROW_ON_OPTIMISM)
  })

  it('indexer chunk query address-filters escrow events on EnterpriseEscrow', async () => {
    const calls: any[] = []
    const provider = {
      getLogs: (filter: any): Promise<ethers.Log[]> => {
        calls.push(filter)
        return Promise.resolve([])
      }
    }
    await retrieveChunkEvents(null as any, provider as any, CHAIN_WITH_ENTERPRISE, 0, 10)
    await retrieveChunkEvents(
      null as any,
      provider as any,
      CHAIN_WITH_ENTERPRISE,
      0,
      10,
      true
    )
    const escrowFilters = calls.filter((c) => c.address !== undefined)
    expect(escrowFilters.map((c) => c.address)).to.deep.equal([
      ESCROW_ON_OPTIMISM,
      ENTERPRISE_ESCROW_ON_OPTIMISM
    ])
  })
})
