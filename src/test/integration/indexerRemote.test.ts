import { expect, assert } from 'chai'
import { createHash } from 'crypto'
import {
    JsonRpcProvider,
    Signer,
    Contract,
    ethers,
    getAddress,
    hexlify,
    ZeroAddress,
} from 'ethers'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { getEventFromTx } from '../../utils/util.js'
import { delay, waitToIndex, signMessage } from './testUtils.js'
import { genericDDO } from '../data/ddo.js'
import { getOceanArtifactsAdresses } from '../../utils/address.js'
import { getMockSupportedNetworks } from '../utils/utils.js'

describe('Indexer stores a new metadata events and orders.', () => {
    let database: Database
    let indexer: OceanIndexer
    let provider: JsonRpcProvider
    let factoryContract: Contract
    let nftContract: Contract
    let publisherAccount: Signer
    let consumerAccount: Signer
    let nftAddress: string
    let datatokenAddress: string
    const chainId = 8996
    let assetDID: string
    let resolvedDDO: Record<string, any>
    let genericAsset: any
    let setMetaDataTxReceipt: any

    const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

    before(async () => {
        const dbConfig = {
            url: 'http://localhost:8108/?apiKey=xyz'
        }
        database = await new Database(dbConfig)
        indexer = new OceanIndexer(database, mockSupportedNetworks)

        const data = getOceanArtifactsAdresses()

        provider = new JsonRpcProvider('http://127.0.0.1:8545')
        publisherAccount = (await provider.getSigner(0)) as Signer
        consumerAccount = (await provider.getSigner(1)) as Signer
        genericAsset = genericDDO
        factoryContract = new ethers.Contract(
            data.development.ERC721Factory,
            ERC721Factory.abi,
            publisherAccount
        )
    })

    it('instance Database', async () => {
        expect(database).to.be.instanceOf(Database)
    })

    it('should publish a dataset', async () => {
        const tx = await factoryContract.createNftWithErc20(
            {
                name: '72120Bundle',
                symbol: '72Bundle',
                templateIndex: 1,
                tokenURI: 'https://oceanprotocol.com/nft/',
                transferable: true,
                owner: await publisherAccount.getAddress()
            },
            {
                strings: ['ERC20B1', 'ERC20DT1Symbol'],
                templateIndex: 1,
                addresses: [
                    await publisherAccount.getAddress(),
                    ZeroAddress,
                    ZeroAddress,
                    '0x0000000000000000000000000000000000000000'
                ],
                uints: [1000, 0],
                bytess: []
            }
        )
        const txReceipt = await tx.wait()
        assert(txReceipt, 'transaction failed')
        const event = getEventFromTx(txReceipt, 'NFTCreated')
        nftAddress = event.args[0]
        assert(nftAddress, 'find nft created failed')
        const datatokenEvent = getEventFromTx(txReceipt, 'TokenCreated')
        datatokenAddress = datatokenEvent.args[0]
        assert(datatokenAddress, 'find datatoken created failed')
    })

    it('should set metadata and save ', async () => {
        nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, publisherAccount)
        genericAsset.id =
            'did:op:' +
            createHash('sha256')
                .update(getAddress(nftAddress) + chainId.toString(10))
                .digest('hex')
        genericAsset.nftAddress = nftAddress
        assetDID = genericAsset.id
        const stringDDO = JSON.stringify(genericAsset)
        const bytes = Buffer.from(stringDDO)
        const metadata = hexlify(bytes)
        const hash = createHash('sha256').update(metadata).digest('hex')

        const setMetaDataTx = await nftContract.setMetaData(
            0,
            'http://v4.provider.oceanprotocol.com',
            '0x123',
            '0x01',
            metadata,
            '0x' + hash,
            []
        )
        setMetaDataTxReceipt = await setMetaDataTx.wait()
        assert(setMetaDataTxReceipt, 'set metada failed')
        // for testing purpose
        genericAsset.event.tx = setMetaDataTxReceipt.transactionHash
        genericAsset.event.block = setMetaDataTxReceipt.blockNumber
        genericAsset.event.from = setMetaDataTxReceipt.from
        genericAsset.event.contract = setMetaDataTxReceipt.contractAddress
        genericAsset.event.datetime = '2023-02-15T16:42:22'

        genericAsset.nft.address = nftAddress
        genericAsset.nft.owner = setMetaDataTxReceipt.from
        genericAsset.nft.state = 0
        genericAsset.nft.created = '2022-12-30T08:40:43'
    })

    delay(30000)

    it('should store the ddo in the database and return it ', async () => {
        resolvedDDO = await waitToIndex(assetDID, database)
        expect(resolvedDDO.id).to.equal(genericAsset.id)
    })

})

