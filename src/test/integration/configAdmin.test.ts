import { Signer, JsonRpcProvider } from 'ethers'
import { Database } from '../../components/database/index.js'
import { getConfiguration, loadConfigFromFile } from '../../utils/index.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment,
  getMockSupportedNetworks
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { OceanNode } from '../../OceanNode.js'
import { FetchConfigHandler } from '../../components/core/admin/fetchConfigHandler.js'
import { PushConfigHandler } from '../../components/core/admin/pushConfigHandler.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'stream'
import { expect } from 'chai'
import { createHashForSignature, safeSign } from '../utils/signature.js'

describe('Config Admin Endpoints Integration Tests', () => {
  let config: OceanNodeConfig
  let database: Database
  let adminAccount: Signer
  let nonAdminAccount: Signer
  let previousConfiguration: OverrideEnvConfig[]
  let oceanNode: OceanNode

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  before(async () => {
    const provider = new JsonRpcProvider('http://127.0.0.1:8545')
    adminAccount = (await provider.getSigner(0)) as Signer
    nonAdminAccount = (await provider.getSigner(1)) as Signer
    const adminAddress = await adminAccount.getAddress()

    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          JSON.stringify([adminAddress])
        ]
      )
    )

    config = await getConfiguration(true)
    database = await Database.init(config.dbConfig)
    oceanNode = OceanNode.getInstance(config, database)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })

  const getAdminSignature = async (nonce: string, command: string): Promise<string> => {
    // const message = expiryTimestamp.toString()
    // return await adminAccount.signMessage(message)

    const messageHashBytes = createHashForSignature(
      await adminAccount.getAddress(),
      nonce,
      command
    )
    const signature = await safeSign(adminAccount, messageHashBytes)
    return signature
  }

  describe('Fetch Config Tests', () => {
    it('should fetch current config', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const nonce = Date.now().toString()
      const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.FETCH_CONFIG)

      const handlerResponse = await new FetchConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.FETCH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature
      })

      expect(handlerResponse.status.httpStatus).to.equal(200)

      const response = await streamToObject(handlerResponse.stream as Readable)
      expect(response).to.be.an('object')
      expect(response).to.have.property('hasHttp')
      expect(response).to.have.property('hasP2P')
    })

    it('should hide private key in fetched config', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const nonce = Date.now().toString()
      const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.FETCH_CONFIG)

      const handlerResponse = await new FetchConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.FETCH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature
      })

      expect(handlerResponse.status.httpStatus).to.equal(200)

      const response = await streamToObject(handlerResponse.stream as Readable)
      expect(response).to.have.property('keys')
      expect(response.keys).to.have.property('privateKey')
      expect(response.keys.privateKey).to.equal('[*** HIDDEN CONTENT ***]')
    })

    it('should reject fetch config with signature from non-admin', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const expiryTimestamp = Date.now() + 60000
      const messageHashBytes = createHashForSignature(
        await nonAdminAccount.getAddress(),
        expiryTimestamp.toString(),
        PROTOCOL_COMMANDS.FETCH_CONFIG
      )
      const invalidSignature = await safeSign(nonAdminAccount, messageHashBytes)

      const handlerResponse = await new FetchConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.FETCH_CONFIG,
        nonce: expiryTimestamp.toString(),
        address: await adminAccount.getAddress(),
        signature: invalidSignature
      })

      expect(handlerResponse.status.httpStatus).to.not.equal(200)
    })

    it('should reject fetch config with expired timestamp', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const nonce = String(Date.now() - 60000)
      const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.FETCH_CONFIG)

      const handlerResponse = await new FetchConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.FETCH_CONFIG,
        nonce,
        signature,
        address: await adminAccount.getAddress()
      })

      expect(handlerResponse.status.httpStatus).to.not.equal(200)
    })
  })

  describe('Push Config Tests', () => {
    it('should push config changes and reload node', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const nonce = Date.now().toString()
      const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)

      const newConfig = {
        rateLimit: 100,
        maxConnections: 200
      }

      const handlerResponse = await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        signature,
        address: await adminAccount.getAddress(),
        config: newConfig
      })

      expect(handlerResponse.status.httpStatus).to.equal(200)

      const response = await streamToObject(handlerResponse.stream as Readable)
      expect(response).to.be.an('object')
      expect(response.rateLimit).to.equal(100)
      expect(response.maxConnections).to.equal(200)

      const savedConfig = loadConfigFromFile()
      expect(savedConfig.rateLimit).to.equal(100)
      expect(savedConfig.maxConnections).to.equal(200)

      const restoreConfig = {
        rateLimit: 30,
        maxConnections: 30
      }
      const nonce2 = Date.now().toString()
      const signature2 = await getAdminSignature(nonce2, PROTOCOL_COMMANDS.PUSH_CONFIG)
      await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        signature: signature2,
        address: await adminAccount.getAddress(),
        config: restoreConfig
      })
    })

    it('should merge new config with existing config', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      let nonce = Date.now().toString()
      let signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.FETCH_CONFIG)

      const fetchResponse = await new FetchConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.FETCH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature
      })

      const currentConfig = await streamToObject(fetchResponse.stream as Readable)

      const partialConfig = {
        rateLimit: 75
      }
      nonce = Date.now().toString()
      signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)

      const pushResponse = await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: partialConfig
      })

      const updatedConfig = await streamToObject(pushResponse.stream as Readable)

      expect(updatedConfig.rateLimit).to.equal(75)
      expect(updatedConfig.maxConnections).to.equal(currentConfig.maxConnections)
      nonce = Date.now().toString()
      signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)

      await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: { rateLimit: currentConfig.rateLimit }
      })
    })

    it('should hide private key in push config response', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      let nonce = Date.now().toString()
      let signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)

      const response = await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: { rateLimit: 50 }
      })

      expect(response.status.httpStatus).to.equal(200)

      const updatedConfig = await streamToObject(response.stream as Readable)
      expect(updatedConfig).to.have.property('keys')
      expect(updatedConfig.keys).to.have.property('privateKey')
      expect(updatedConfig.keys.privateKey).to.equal('[*** HIDDEN CONTENT ***]')
      nonce = Date.now().toString()
      signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)
      await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: { rateLimit: 30 }
      })
    })

    it('should reject push config with signature from non-admin', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const expiryTimestamp = Date.now() + 60000
      const messageHashBytes = createHashForSignature(
        await nonAdminAccount.getAddress(),
        expiryTimestamp.toString(),
        PROTOCOL_COMMANDS.FETCH_CONFIG
      )
      const invalidSignature = await safeSign(nonAdminAccount, messageHashBytes)

      const handlerResponse = await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce: expiryTimestamp.toString(),
        address: await adminAccount.getAddress(),
        signature: invalidSignature,
        config: { rateLimit: 100 }
      })

      expect(handlerResponse.status.httpStatus).to.not.equal(200)
    })

    it('should reject push config with old nonce', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const expiryTimestamp = Date.now() - 60000
      const nonce = expiryTimestamp.toString()
      const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)
      const handlerResponse = await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: { rateLimit: 100 }
      })

      expect(handlerResponse.status.httpStatus).to.not.equal(200)
    })

    it('should reject push config with missing config parameter', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const nonce = Date.now().toString()
      const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)

      const handlerResponse = await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: undefined
      })

      expect(handlerResponse.status.httpStatus).to.equal(400)
    })

    it('should reject push config with invalid config type', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const nonce = Date.now().toString()
      const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)

      const handlerResponse = await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: 'invalid' as any
      })

      expect(handlerResponse.status.httpStatus).to.equal(400)
    })

    it('should reject push config with invalid field values (Zod validation)', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const nonce = Date.now().toString()
      const signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)

      const handlerResponse = await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: { rateLimit: 'not-a-number' as any }
      })

      expect(handlerResponse.status.httpStatus).to.equal(400)
      expect(handlerResponse.status.error).to.not.equal(undefined)
      expect(handlerResponse.stream).to.equal(null)
    })
  })

  describe('Config Reload Tests', () => {
    it('should reload node configuration after push', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      let nonce = Date.now().toString()
      let signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)

      const configBefore = await getConfiguration()

      await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: { rateLimit: 999 }
      })

      const configAfter = await getConfiguration()

      expect(configAfter.rateLimit).to.equal(999)
      expect(configAfter.rateLimit).to.not.equal(configBefore.rateLimit)
      nonce = Date.now().toString()
      signature = await getAdminSignature(nonce, PROTOCOL_COMMANDS.PUSH_CONFIG)
      await new PushConfigHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.PUSH_CONFIG,
        nonce,
        address: await adminAccount.getAddress(),
        signature,
        config: { rateLimit: configBefore.rateLimit }
      })
    })

    after(async () => {
      await tearDownEnvironment(previousConfiguration)
    })
  })
})
