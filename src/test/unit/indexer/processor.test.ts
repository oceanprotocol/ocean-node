import { expect } from 'chai'
import sinon from 'sinon'
import { Interface, ethers } from 'ethers'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' with { type: 'json' }
import { processChunkLogs } from '../../../components/Indexer/processor.js'
import { MetadataEventProcessor } from '../../../components/Indexer/processors/index.js'
import { EVENTS } from '../../../utils/constants.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'

describe('Indexer processor MetadataValidated check', () => {
  const chainId = 8996
  const nftAddress = '0x1111111111111111111111111111111111111111'
  const validator = '0x2222222222222222222222222222222222222222'
  const erc721Interface = new Interface(ERC721Template.abi)
  let processEventStub: sinon.SinonStub

  beforeEach(() => {
    processEventStub = sinon
      .stub(MetadataEventProcessor.prototype, 'processEvent')
      .resolves('processed')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('processes a metadata event whose MetadataValidated proof comes from an allowed validator', async () => {
    const metadataCreated = erc721Interface.encodeEventLog(
      erc721Interface.getEvent('MetadataCreated'),
      [validator, 0, 'http://decryptor', '0x', '0x', ethers.ZeroHash, 0, 1]
    )
    const metadataValidated = erc721Interface.encodeEventLog(
      erc721Interface.getEvent('MetadataValidated'),
      [validator, ethers.ZeroHash, 27, ethers.ZeroHash, ethers.ZeroHash]
    )
    const logs = [
      {
        topics: metadataCreated.topics,
        data: metadataCreated.data,
        address: nftAddress,
        transactionHash: '0xaaa'
      }
    ] as unknown as ethers.Log[]
    const provider = {
      getTransactionReceipt: () =>
        Promise.resolve({
          logs: [
            {
              topics: metadataValidated.topics,
              data: metadataValidated.data,
              address: nftAddress
            }
          ]
        })
    }
    const config = {
      allowedValidators: [validator],
      allowedValidatorsList: undefined
    } as unknown as OceanNodeConfig

    const storeEvents = await processChunkLogs(
      logs,
      {} as ethers.Signer,
      provider as unknown as ethers.FallbackProvider,
      chainId,
      config
    )
    expect(processEventStub.calledOnce).to.equal(true)
    expect(storeEvents[EVENTS.METADATA_CREATED]).to.equal('processed')
  })
})
