import { expect, assert } from 'chai'
import { getConfiguration } from '../../utils/config.js'
import { OceanNode } from '../../OceanNode.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { EncryptFileHandler } from '../../components/core/handler/encryptHandler.js'
import { EncryptFileCommand } from '../../@types/commands'
import { EncryptMethod, FileObjectType, UrlFileObject } from '../../@types/fileObject.js'
import { JsonRpcProvider, Signer, ethers } from 'ethers'
import fs from 'fs'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { Database } from '../../components/database/index.js'

describe('Encrypt File', () => {
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  let previousConfiguration: OverrideEnvConfig[]
  let provider: JsonRpcProvider
  let consumerAccount: Signer

  before(async () => {
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.PRIVATE_KEY],
        ['0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58']
      )
    )
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    consumerAccount = (await provider.getSigner(1)) as Signer
    config = await getConfiguration(true) // Force reload the configuration
    const dbconn = await Database.init(config.dbConfig)
    oceanNode = await OceanNode.getInstance(config, dbconn)
  })

  it('should encrypt files', async () => {
    const wallet = new ethers.Wallet(
      '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
    )
    const nonce = Date.now().toString()
    const message = String(nonce)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    const encryptFileTask: EncryptFileCommand = {
      command: PROTOCOL_COMMANDS.ENCRYPT_FILE,
      nonce,
      consumerAddress: await wallet.getAddress(),
      signature,
      encryptionType: EncryptMethod.AES,
      files: {
        type: FileObjectType.URL,
        url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
        method: 'GET'
      } as UrlFileObject
    }
    const response = await new EncryptFileHandler(oceanNode).handle(encryptFileTask)

    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const expectedHeaders = {
      'Content-Type': 'application/octet-stream',
      'X-Encrypted-By': oceanNode.getKeyManager().getPeerId().toString(),
      'X-Encrypted-Method': EncryptMethod.AES
    }
    expect(response.status.headers).to.deep.equal(expectedHeaders)
  })

  it('should encrypt raw data file on body (AES)', async () => {
    // should return a buffer
    const file: Buffer = fs.readFileSync('src/test/data/organizations-100.aes')
    const wallet = new ethers.Wallet(
      '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
    )
    const nonce = Date.now().toString()
    const message = String(nonce)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await consumerAccount.signMessage(messageHashBytes)
    const encryptFileTask: EncryptFileCommand = {
      command: PROTOCOL_COMMANDS.ENCRYPT_FILE,
      encryptionType: EncryptMethod.AES,
      rawData: file,
      nonce,
      consumerAddress: await wallet.getAddress(),
      signature
    }
    const response = await new EncryptFileHandler(oceanNode).handle(encryptFileTask)

    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)
    const expectedHeaders = {
      'Content-Type': 'application/octet-stream',
      'X-Encrypted-By': oceanNode.getKeyManager().getPeerId().toString(),
      'X-Encrypted-Method': EncryptMethod.AES
    }
    expect(response.status.headers).to.deep.equal(expectedHeaders)
  })

  it('should encrypt raw data file on body (ECIES)', async () => {
    // should return a buffer
    const file: Buffer = fs.readFileSync('src/test/data/organizations-100.aes')
    const nonce = Date.now().toString()
    const message = String(nonce)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await consumerAccount.signMessage(messageHashBytes)
    const encryptFileTask: EncryptFileCommand = {
      command: PROTOCOL_COMMANDS.ENCRYPT_FILE,
      encryptionType: EncryptMethod.ECIES,
      rawData: file,
      nonce,
      consumerAddress: await consumerAccount.getAddress(),
      signature
    }
    const response = await new EncryptFileHandler(oceanNode).handle(encryptFileTask)

    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)
    const expectedHeaders = {
      'Content-Type': 'application/octet-stream',
      'X-Encrypted-By': oceanNode.getKeyManager().getPeerId().toString(),
      'X-Encrypted-Method': EncryptMethod.ECIES
    }
    expect(response.status.headers).to.deep.equal(expectedHeaders)
  })

  it('should return unknown file type', async () => {
    const nonce = Date.now().toString()
    const message = String(nonce)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await consumerAccount.signMessage(messageHashBytes)
    const encryptFileTask: EncryptFileCommand = {
      command: PROTOCOL_COMMANDS.ENCRYPT_FILE,
      encryptionType: EncryptMethod.AES,
      files: {
        type: 'Unknown',
        url: 'Unknown',
        method: 'Unknown'
      } as UrlFileObject,
      nonce,
      consumerAddress: await consumerAccount.getAddress(),
      signature
    }
    const response = await new EncryptFileHandler(oceanNode).handle(encryptFileTask)

    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 500, 'Failed to get 500 response')
    expect(response.status.error).to.be.equal(
      'Unknown error: Invalid storage type: Unknown'
    )
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
