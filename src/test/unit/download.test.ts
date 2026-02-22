import { expect, assert } from 'chai'
import { OceanNode } from '../../OceanNode.js'
import { Database } from '../../components/database/index.js'
import { getConfiguration } from '../../utils/config.js'
import { EncryptHandler } from '../../components/core/handler/encryptHandler.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { EncryptMethod } from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { streamToString } from '../../utils/util.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { validateFilesStructure } from '../../components/core/handler/downloadHandler.js'
import { AssetUtils, isConfidentialChainDDO } from '../../utils/asset.js'
import { DEVELOPMENT_CHAIN_ID, KNOWN_CONFIDENTIAL_EVMS } from '../../utils/address.js'
import { DDO } from '@oceanprotocol/ddo-js'
import { Wallet, ethers } from 'ethers'
import { KeyManager } from '../../components/KeyManager/index.js'

let envOverrides: OverrideEnvConfig[]
let config: OceanNodeConfig
let db: Database
let oceanNode: OceanNode

describe('Should validate files structure for download', () => {
  let consumerAccount: Wallet
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.PRIVATE_KEY],
      ['0x3634cc4a3d2694a1186a7ce545f149e022eea103cc254d18d08675104bb4b5ac']
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    const keyManager = new KeyManager(config)
    db = await Database.init(config.dbConfig)
    oceanNode = OceanNode.getInstance(
      config,
      db,
      null,
      null,
      null,
      keyManager,
      null,
      true
    )
    consumerAccount = new Wallet(process.env.PRIVATE_KEY)
  })

  const ddoObj: DDO = {
    '@context': ['https://w3id.org/did/v1'],
    id: 'did:op:be031e471e515d2e199868079585cf3c0d9100db55aa63f65c149d20fa7bb906',
    nftAddress: '0x60A5151266f6D9118e13aA658e2ab5a9109FC6B2',
    version: '4.1.0',
    chainId: 11155420,
    metadata: {
      created: '2023-12-20T14:35:20Z',
      updated: '2023-12-20T14:35:20Z',
      type: 'dataset',
      name: 'ocean-cli demo asset',
      description: 'asset published using ocean cli tool',
      tags: ['test'],
      author: 'oceanprotocol',
      license: 'https://market.oceanprotocol.com/terms',
      additionalInformation: { termsAndConditions: true }
    },
    services: [
      {
        id: 'ccb398c50d6abd5b456e8d7242bd856a1767a890b537c2f8c10ba8b8a10e6025',
        type: 'access',
        files:
          '0x04c9222ab6253589991d414576ba1a1926051a3a5b9490969c3838994f6a9fdf91783d0581ff8ade5ebb8a6a42a06d235a8c038db1f823ab1deae6c27069c39657d5f4fa612027f0f1e461f36108b27d1da717f3a2d056e9e68ac7d3ac1d8de99ab9d9ac62ea26960e6133ac3004bcfa6cf0d03a501e62283a525b1d24b56202251e2d4466947846b884919763ab1620bd8e05da9256bec77c3cfce8908d2c5045d88a3fdc7dcb791b6278c8c9a9c44f530de839ca18f7697ca8d64b20622b370b3baccaaf429b96ddfc2a113c74b5ba8408943dd36a7b366b2bb2596b0212756bbe2b0e40c72c72a9a8a38d469d0926517a26fc177b3c73363130a5fce69439852dfe80ead9ad46fa46be2dfc08719f7eb13c045b759ece6b08a9bb7af842911b8fb2a0249092409c9910ce6f602e87cca7a90aad9dfb961db68973738ab9f721abeefd79bb3447990e64779dc89ba619280fc1cf2d54c1dcd7582b7955',
        datatokenAddress: '0xD73B1A4aac832EBC811247df8E9e523527BCE953',
        serviceEndpoint: 'http://127.0.0.1:8001',
        timeout: 86400
      }
    ]
  }

  const assetURL = {
    datatokenAddress: '0xD73B1A4aac832EBC811247df8E9e523527BCE953',
    nftAddress: '0x60A5151266f6D9118e13aA658e2ab5a9109FC6B2',
    files: [
      {
        type: 'url',
        url: 'https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-abstract10.xml.gz-rss.xml',
        method: 'GET'
      }
    ]
  }
  // encrypts the assetURL using the encrypt handler (what goes into services files at publish time),
  // and decrypts the data back to the original format
  const getDecryptedData = async function () {
    const nonce = Date.now().toString()
    const message = String(nonce)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await consumerAccount.signMessage(messageHashBytes)
    const result = await new EncryptHandler(oceanNode).handle({
      blob: JSON.stringify(assetURL),
      encoding: 'string',
      encryptionType: EncryptMethod.ECIES,
      command: PROTOCOL_COMMANDS.ENCRYPT,
      nonce,
      consumerAddress: await consumerAccount.getAddress(),
      signature
    })

    const encryptedData: string = await streamToString(result.stream as Readable)
    const serviceData = {
      files: encryptedData
    }

    const data = Uint8Array.from(Buffer.from(serviceData.files.slice(2), 'hex'))

    const decryptedUrlBytes = await oceanNode
      .getKeyManager()
      .decrypt(data, EncryptMethod.ECIES)
    // Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    // back to JSON representation
    const decryptedFileArray = JSON.parse(decryptedFilesString)
    return decryptedFileArray
  }

  it('should validate "nftAddress" and "datatokenAddress" from files', async () => {
    const decryptedFileArray = await getDecryptedData()
    const decriptedFileObject: any = decryptedFileArray.files
    expect(decriptedFileObject[0]).to.be.deep.equal(assetURL.files[0])
    // validate the structure of the files object
    const service = AssetUtils.getServiceByIndex(ddoObj, 0)
    expect(validateFilesStructure(ddoObj, service, decryptedFileArray)).to.be.equal(true)
  })

  it('should NOT validate "nftAddress" and "datatokenAddress" from files', async () => {
    const otherNFTAddress = '0x3b7aE751aBA144e9A0ffc5A5C1D00bB4055A7bDc'
    const otherDatatokenAddress = '0x32b24528675172841d89BBA7504A930B049aBd30'
    const decryptedFileArray = await getDecryptedData()
    const otherDDOSameFiles = structuredClone(ddoObj)
    // just change nft address
    otherDDOSameFiles.nftAddress = otherNFTAddress
    otherDDOSameFiles.services[0].datatokenAddress = otherDatatokenAddress

    const service = AssetUtils.getServiceByIndex(otherDDOSameFiles, 0)
    // its the same service files structure (same encrypted data),
    // but its not the same ddo so there is no matching
    expect(
      validateFilesStructure(otherDDOSameFiles, service, decryptedFileArray)
    ).to.be.equal(false)

    // this encrypted file data if for assetURL with otherNFTAddress and otherDatatokenAddress above
    const newAssetURL = structuredClone(assetURL)
    newAssetURL.nftAddress = otherNFTAddress
    newAssetURL.datatokenAddress = otherDatatokenAddress
    const nonce = Date.now().toString()
    const message = String(nonce)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await consumerAccount.signMessage(messageHashBytes)
    const result = await new EncryptHandler(oceanNode).handle({
      blob: JSON.stringify(newAssetURL),
      encoding: 'string',
      encryptionType: EncryptMethod.ECIES,
      command: PROTOCOL_COMMANDS.ENCRYPT,
      nonce,
      consumerAddress: await consumerAccount.getAddress(),
      signature
    })

    const encryptedFilesData: string = await streamToString(result.stream as Readable)
    const sameDDOOtherFiles = ddoObj
    sameDDOOtherFiles.services[0].files = encryptedFilesData
    expect(
      validateFilesStructure(sameDDOOtherFiles, service, decryptedFileArray)
    ).to.be.equal(false)

    const data = Uint8Array.from(Buffer.from(encryptedFilesData.slice(2), 'hex'))

    const decryptedUrlBytes = await oceanNode
      .getKeyManager()
      .decrypt(data, EncryptMethod.ECIES)
    // Convert the decrypted bytes back to a string
    const decryptedFilesString = Buffer.from(decryptedUrlBytes).toString()
    // back to JSON representation
    const decryptedFileData = JSON.parse(decryptedFilesString)
    assert(
      decryptedFileData.datatokenAddress?.toLowerCase() ===
        otherDatatokenAddress?.toLowerCase()
    )
    assert(decryptedFileData.nftAddress?.toLowerCase() === otherNFTAddress?.toLowerCase())
  })

  it('should check if DDO service files is missing or empty (exected for confidential EVM, dt4)', () => {
    const otherDDOConfidential = structuredClone(ddoObj)
    expect(
      isConfidentialChainDDO(KNOWN_CONFIDENTIAL_EVMS[0], otherDDOConfidential.services[0])
    ).to.be.equal(false)

    // now it should return true
    otherDDOConfidential.services[0].files = ''

    expect(
      isConfidentialChainDDO(KNOWN_CONFIDENTIAL_EVMS[0], otherDDOConfidential.services[0])
    ).to.be.equal(true)

    // not confidential evm anymore
    expect(
      isConfidentialChainDDO(
        BigInt(DEVELOPMENT_CHAIN_ID),
        otherDDOConfidential.services[0]
      )
    ).to.be.equal(false)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
