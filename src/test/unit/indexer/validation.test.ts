import { DDOExample, ddov5, ddov7, ddoValidationSignature } from '../../data/ddo.js'
import { getValidationSignature } from '../../../components/core/utils/validateDdoHandler.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../../utils/index.js'
import { expect } from 'chai'
import {
  setupEnvironment,
  tearDownEnvironment,
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  getMockSupportedNetworks,
  TEST_ENV_CONFIG_FILE
} from '../../utils/utils.js'
import { DDOManager, DDO } from '@oceanprotocol/ddo-js'
import { ValidateDDOHandler } from '../../../components/core/handler/ddoHandler.js'
import { OceanNode } from '../../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { RPCS } from '../../../@types/blockchain.js'
import { Database } from '../../../components/database/index.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
// import sinon, { SinonSandbox } from 'sinon'
import { Signer, JsonRpcProvider } from 'ethers'
import { Readable } from 'stream'
import { createHashForSignature, safeSign } from '../../utils/signature.js'

describe('Schema validation tests', () => {
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let envOverrides: OverrideEnvConfig[]
  let mockDatabase: Database
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  let consumerAccount: Signer
  // let sandbox: SinonSandbox

  // For token validation, please check integration test cases
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.VALIDATE_UNSIGNED_DDO,
        ENVIRONMENT_VARIABLES.PRIVATE_KEY,
        ENVIRONMENT_VARIABLES.IPFS_GATEWAY,
        ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY,
        ENVIRONMENT_VARIABLES.RPCS
      ],
      [
        'false',
        '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
        'https://ipfs.io/',
        'https://arweave.net/',
        JSON.stringify(mockSupportedNetworks)
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    const provider = new JsonRpcProvider('http://127.0.0.1:8545')
    consumerAccount = (await provider.getSigner(1)) as Signer
    /* sandbox = sinon.createSandbox()
    sandbox.stub(Database, 'init').resolves({
      nonce: {},
      c2d: {},
      authToken: {},
      sqliteConfig: {},
      ddo: {},
      indexer: {},
      logs: {},
      order: {},
      ddoState: {}
    } as any)
     */
    mockDatabase = await Database.init(config.dbConfig)
    oceanNode = await OceanNode.getInstance(
      config,
      mockDatabase,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )
  })

  after(() => {
    // Restore original local setup / env variables after test
    tearDownEnvironment(envOverrides)
  })

  it('should pass the validation on version 4.1.0', async () => {
    const ddoInstance = DDOManager.getDDOClass(DDOExample)
    const validationResult = await ddoInstance.validate()
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })

  it('should not pass due to invalid metadata.created on version 4.1.0', async () => {
    const copy = JSON.parse(JSON.stringify(DDOExample))
    copy['@context'] = ['https://w3id.org/did/v1']
    delete copy.metadata.created
    const ddoInstance = DDOManager.getDDOClass(copy)
    const validationResult = await ddoInstance.validate()
    expect(validationResult[0]).to.eql(false)
  })
  // TO DO after fixing regex for created & updated: it('should not pass due to invalid ISO timestamp on version 4.1.0', async () => {

  it('4.5.0 should pass the validation without service', async () => {
    const ddoInstance = DDOManager.getDDOClass(ddov5)
    const validationResult = await ddoInstance.validate()
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })

  it('should pass the validation and return signature', async () => {
    const ddoInstance = DDOManager.getDDOClass(ddoValidationSignature)
    const validationResult = await ddoInstance.validate()
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
    const signatureResult = await getValidationSignature(
      JSON.stringify(ddoValidationSignature)
    )
    expect(signatureResult).to.eql({
      hash: '0xa291d25eb3dd0c8487dc2d55baa629184e7b668ed1c579198a434eca9c663ac4',
      publicKey: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260',
      r: '0xc61361803ca3402afa2406dfc3e2729dd8f0c21d06c1456cc1668510b23951c0',
      s: '0x008b965fa2df393765d32942a7d8114d529a602cd7aa672d23d21f90dbeae2fd',
      v: 28
    })
  })

  it('should pass the validation on version 4.7.0', async () => {
    const ddoInstance = DDOManager.getDDOClass(ddov7)
    const validationResult = await ddoInstance.validate()
    console.log('Validation 4.7.0 result: ', validationResult)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })

  it('should pass the validation on version 4.7.0 without credentials', async () => {
    const newDDO = structuredClone(ddov7)
    delete newDDO.services[0].credentials
    const ddoInstance = DDOManager.getDDOClass(newDDO)
    const validationResult = await ddoInstance.validate()
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })

  it('should fail validation when signature is missing', async () => {
    const handler = new ValidateDDOHandler(oceanNode)
    const ddoInstance = DDOManager.getDDOClass(DDOExample)
    const task = {
      ddo: ddoInstance.getDDOData() as DDO,
      publisherAddress: '0x8F292046bb73595A978F4e7A131b4EBd03A15e8a',
      nonce: '123456',
      command: PROTOCOL_COMMANDS.VALIDATE_DDO
    }

    const result = await handler.handle(task)
    expect(result.status.httpStatus).to.equal(401)
  })

  it('should fail validation when signature is invalid', async () => {
    const handler = new ValidateDDOHandler(oceanNode)
    const ddoInstance = DDOManager.getDDOClass(DDOExample)
    const ddo: DDO = {
      ...(ddoInstance.getDDOData() as DDO)
    }
    const task = {
      ddo,
      publisherAddress: '0x8F292046bb73595A978F4e7A131b4EBd03A15e8a',
      nonce: '123456',
      signature: '0xInvalidSignature',
      command: PROTOCOL_COMMANDS.VALIDATE_DDO
    }

    const result = await handler.handle(task)

    expect(result.status.httpStatus).to.equal(401)
  })

  it('should have node signature for valid user', async () => {
    const handler = new ValidateDDOHandler(oceanNode)
    const ddoInstance = DDOManager.getDDOClass(DDOExample)
    const ddo: DDO = {
      ...(ddoInstance.getDDOData() as DDO)
    }
    const nonce = Date.now().toString()
    const messageHashBytes = createHashForSignature(
      await consumerAccount.getAddress(),
      nonce,
      PROTOCOL_COMMANDS.VALIDATE_DDO
    )
    const signature = await safeSign(consumerAccount, messageHashBytes)
    const task = {
      ddo,
      publisherAddress: await consumerAccount.getAddress(),
      nonce,
      signature,
      command: PROTOCOL_COMMANDS.VALIDATE_DDO
    }

    const result = await handler.handle(task)

    expect(result.status.httpStatus).to.equal(200)
    expect(result.stream).to.be.instanceOf(Readable)
  })
})
