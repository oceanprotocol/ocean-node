import {
  Contract,
  ethers,
  getAddress,
  hexlify,
  JsonRpcProvider,
  Signer,
  ZeroAddress
} from 'ethers'
import { assert, expect } from 'chai'
import { getEventFromTx, streamToString } from '../../utils/util.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import { RPCS } from '../../@types/blockchain.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { genericDDO } from '../data/ddo.js'
import { createHash } from 'crypto'
import { encrypt } from '../../utils/crypt.js'
import { Database } from '../../components/database/index.js'
import { DecryptDdoHandler } from '../../components/core/handler/ddoHandler.js'
import {
  ENVIRONMENT_VARIABLES,
  getConfiguration,
  PROTOCOL_COMMANDS
} from '../../utils/index.js'
import { Readable } from 'stream'
import { OceanNode } from '../../OceanNode.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { DecryptDDOCommand } from '../../@types/commands.js'
import { EncryptMethod } from '../../@types/fileObject.js'
import { homedir } from 'os'
import { OceanIndexer } from '../../components/Indexer/index.js'

describe('Should encrypt and decrypt DDO', () => {
  let database: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let publisherAddress: string
  let factoryContract: Contract
  let nftContract: Contract
  let dataNftAddress: string
  let datatokenAddress: string
  let genericAsset: any
  let txReceiptEncryptDDO: any
  let encryptedMetaData: any
  let documentHash: any
  let indexer: OceanIndexer
  const nonce = Date.now().toString()

  const chainId = 8996
  const mockSupportedNetworks: RPCS = {
    '8996': {
      chainId: 8996,
      network: 'development',
      rpc: 'http://127.0.0.1:8545',
      chunkSize: 100
    }
  }

  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    publisherAddress = await publisherAccount.getAddress()
    genericAsset = genericDDO
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
        ],
        [
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          JSON.stringify([publisherAddress]),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )
    let artifactsAddresses = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!artifactsAddresses) {
      artifactsAddresses = getOceanArtifactsAdresses().development
    }
    factoryContract = new ethers.Contract(
      artifactsAddresses.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
    const config = await getConfiguration()
    database = await Database.init(config.dbConfig)
    oceanNode = OceanNode.getInstance(config, database)
    // will be used later
    indexer = new OceanIndexer(database, mockSupportedNetworks)
    oceanNode.addIndexer(indexer)
  })

  it('should publish a dataset', async () => {
    const tx = await (factoryContract as any).createNftWithErc20(
      {
        name: '72120Bundle',
        symbol: '72Bundle',
        templateIndex: 1,
        tokenURI: 'https://oceanprotocol.com/nft/',
        transferable: true,
        owner: publisherAddress
      },
      {
        strings: ['ERC20B1', 'ERC20DT1Symbol'],
        templateIndex: 1,
        addresses: [publisherAddress, ZeroAddress, ZeroAddress, ZeroAddress],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txReceipt = await tx.wait()
    assert(txReceipt, 'transaction failed')
    const nftEvent = getEventFromTx(txReceipt, 'NFTCreated')
    const erc20Event = getEventFromTx(txReceipt, 'TokenCreated')
    dataNftAddress = nftEvent.args[0]
    datatokenAddress = erc20Event.args[0]
    assert(dataNftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')
  })

  it('should encrypt ddo and set metadata', async () => {
    nftContract = new ethers.Contract(
      dataNftAddress,
      ERC721Template.abi,
      publisherAccount
    )
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(dataNftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = dataNftAddress
    genericAsset.services[0].datatokenAddress = datatokenAddress

    documentHash =
      '0x' + createHash('sha256').update(JSON.stringify(genericAsset)).digest('hex')

    const genericAssetData = Uint8Array.from(Buffer.from(JSON.stringify(genericAsset)))
    const encryptedData = await encrypt(genericAssetData, EncryptMethod.ECIES)
    encryptedMetaData = hexlify(encryptedData)

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x02',
      encryptedMetaData,
      documentHash,
      []
    )
    txReceiptEncryptDDO = await setMetaDataTx.wait()
    assert(txReceiptEncryptDDO, 'set metada failed')
  })

  it('should return unsupported chain id', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId: 123,
      nonce,
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.include('Decrypt DDO: Unsupported chain id')
  })

  it('should return error duplicate nonce', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId: 8996,
      nonce,
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(`Decrypt DDO: duplicate nonce`)
  })

  it('should return decrypter not authorized', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: '0x0000000000000000000000000000000000000001',
      chainId,
      nonce: Date.now().toString(),
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(403)
    expect(response.status.error).to.equal('Decrypt DDO: Decrypter not authorized')
  })

  it('should authorize decrypter since is this node', async () => {
    const config = await getConfiguration()
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: await config.keys.ethAddress,
      chainId,
      nonce: Date.now().toString(),
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.not.equal(403)
    expect(response.status.error).to.not.equal('Decrypt DDO: Decrypter not authorized')
  })

  it('should return asset not deployed by the data NFT factory', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId,
      dataNftAddress: publisherAddress,
      nonce: Date.now().toString(),
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(
      'Decrypt DDO: Asset not deployed by the data NFT factory'
    )
  })

  it('should return failed to process transaction id', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId,
      transactionId: 'string',
      dataNftAddress,
      nonce: Date.now().toString(),
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(
      'Decrypt DDO: Failed to process transaction id'
    )
  })

  it('should return failed to convert input args to bytes', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId,
      encryptedDocument: '123',
      flags: 1,
      documentHash: '123',
      dataNftAddress,
      nonce: Date.now().toString(),
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(
      'Decrypt DDO: Failed to convert input args to bytes'
    )
  })

  it('should return data NFT factory does not match', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId,
      encryptedDocument: encryptedMetaData,
      flags: 2,
      documentHash: '0x123',
      dataNftAddress: '0x0000000000000000000000000000000000000001',
      nonce: Date.now().toString(),
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(
      'Decrypt DDO: Asset not deployed by the data NFT factory'
    )
  })

  it('should return checksum does not match', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId,
      encryptedDocument: encryptedMetaData,
      flags: 2,
      documentHash: '0x123',
      dataNftAddress,
      nonce: Date.now().toString(),
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal('Decrypt DDO: checksum does not match')
  })

  it('should return signature does not match', async () => {
    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId,
      transactionId: txReceiptEncryptDDO.hash,
      dataNftAddress,
      nonce: Date.now().toString(),
      documentHash,
      signature: '0x123'
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.equal(
      'Decrypt DDO: invalid signature or does not match'
    )
  })

  it('should decrypt ddo with transactionId and return it', async () => {
    const nonce = Date.now().toString()
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY)
    const message = String(
      txReceiptEncryptDDO.hash +
        dataNftAddress +
        publisherAddress +
        chainId.toString() +
        nonce
    )
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const signature = await wallet.signMessage(messageHash)

    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId,
      transactionId: txReceiptEncryptDDO.hash,
      dataNftAddress,
      nonce,
      signature
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(200)
    const decryptedStringDDO = await streamToString(response.stream as Readable)
    const stringDDO = JSON.stringify(genericAsset)
    expect(decryptedStringDDO).to.equal(stringDDO)
  })

  it('should decrypt ddo with encryptedDocument, flags, documentHash and return it', async () => {
    const nonce = Date.now().toString()
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY)
    const message = String(dataNftAddress + publisherAddress + chainId.toString() + nonce)
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const signature = await wallet.signMessage(messageHash)

    const decryptDDOTask: DecryptDDOCommand = {
      command: PROTOCOL_COMMANDS.DECRYPT_DDO,
      decrypterAddress: publisherAddress,
      chainId,
      encryptedDocument: encryptedMetaData,
      flags: 2,
      documentHash,
      dataNftAddress,
      nonce,
      signature
    }
    const response = await new DecryptDdoHandler(oceanNode).handle(decryptDDOTask)
    expect(response.status.httpStatus).to.equal(200)
    const decryptedStringDDO = await streamToString(response.stream as Readable)
    const stringDDO = JSON.stringify(genericAsset)
    expect(decryptedStringDDO).to.equal(stringDDO)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllThreads()
  })
})
