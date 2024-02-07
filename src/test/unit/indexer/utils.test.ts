import {
  Block,
  OrphanFilter,
  TransactionReceipt,
  TransactionResponse,
  ethers
} from 'ethers'
import { expect } from 'chai'
import {
  getDeployedContractBlock,
  getNetworkHeight,
  processBlocks,
  processChunkLogs
} from '../../../components/Indexer/utils.js'

describe('Utils', () => {
  let provider: ethers.JsonRpcProvider
  let signer: ethers.Wallet

  before(async () => {
    provider = new ethers.JsonRpcProvider('https://rpc-mumbai.maticvigil.com')
    signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider)
  })

  it('should get deployed contract block', async () => {
    const deployedBlock = await getDeployedContractBlock(80001)
    expect(deployedBlock).to.be.a('number')
  })

  it('should get network height', async () => {
    const networkHeight = await getNetworkHeight(provider)
    expect(networkHeight).to.be.a('number')
  })

  it('should process blocks', async () => {
    const startIndex = 100
    const count = 5
    const processedBlocks = await processBlocks(
      signer,
      provider,
      80001,
      startIndex,
      count
    )
    expect(processedBlocks.lastBlock).to.be.a('number')
  })

  it('should process event data', async () => {
    async function getBlock(): Promise<Block> {
      return {} as Block
    }
    async function getTransaction(): Promise<TransactionResponse> {
      return {} as TransactionResponse
    }
    async function getTransactionReceipt(): Promise<TransactionReceipt> {
      return {} as TransactionReceipt
    }
    function removedEvent(): OrphanFilter {
      return {} as OrphanFilter
    }
    const logs = [
      {
        provider,
        transactionHash: 'str',
        blockHash: 'str',
        blockNumber: 100,
        timestamp: 100,
        logIndex: 100,
        index: 100,
        transactionIndex: 100,
        address: 'str',
        data: 'abcdef',
        removed: false,
        topics: ['0x49a0cb7b80992c55744fa9510891b184199580af9b73325e21762948f7888a77'],
        toJSON: () => {},
        getBlock,
        getTransaction,
        getTransactionReceipt,
        removedEvent
      }
    ]

    await processChunkLogs(logs, signer, provider, 80001)
  })
})
