import { JsonRpcProvider, Signer, Wallet } from 'ethers'
import { Database } from '../../components/database/index.js'
import { Auth } from '../../components/Auth/index.js'
import { getConfiguration, getMessageHash } from '../../utils/index.js'
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
import {
  CreateAuthTokenHandler,
  InvalidateAuthTokenHandler
} from '../../components/core/handler/authHandler.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'stream'
import { expect } from 'chai'
import { ValidateDDOHandler } from '../../components/core/handler/ddoHandler.js'

describe('Auth Token Integration Tests', () => {
  let config: OceanNodeConfig
  let database: Database
  let auth: Auth
  let provider: JsonRpcProvider
  let consumerAccount: Signer
  let previousConfiguration: OverrideEnvConfig[]
  let oceanNode: OceanNode

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  before(async () => {
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.VALIDATE_UNSIGNED_DDO
        ],
        [JSON.stringify(mockSupportedNetworks), JSON.stringify([8996]), 'false']
      )
    )

    config = await getConfiguration(true)
    database = await new Database(config.dbConfig)
    auth = new Auth(database.authToken)
    oceanNode = await OceanNode.getInstance(config, database)

    provider = new JsonRpcProvider(mockSupportedNetworks['8996'].rpc)

    const consumerPrivateKey =
      '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
    consumerAccount = new Wallet(consumerPrivateKey, provider)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })

  const getRandomNonce = () => {
    return Date.now().toString()
  }

  const ddoValiationRequest = async (token: string) => {
    try {
      const validateHandler = new ValidateDDOHandler(oceanNode)
      const validateResponse = await validateHandler.handle({
        command: PROTOCOL_COMMANDS.VALIDATE_DDO,
        authorization: token,
        ddo: {
          id: 'did:op:f00896cc6f5f9f2c17be06dd28bd6be085e1406bb55274cbd2b65b7271e7b104',
          '@context': [],
          version: '4.1.0',
          nftAddress: '0x3357cCd4e75536422b61F6aeda3ad38545b9b01F',
          chainId: 11155111,
          metadata: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            type: 'dataset',
            name: 'Test DDO',
            description: 'Test DDO',
            tags: [],
            author: 'Test Author',
            license: 'https://market.oceanprotocol.com/terms',
            additionalInformation: {
              termsAndConditions: true
            }
          },
          services: [
            {
              id: 'ccb398c50d6abd5b456e8d7242bd856a1767a890b537c2f8c10ba8b8a10e6025',
              type: 'compute',
              files: '0x0',
              datatokenAddress: '0x0Cf4BE72EAD0583deD382589aFcbF34F3E860Bdc',
              serviceEndpoint: '',
              timeout: 86400
            }
          ]
        }
      })

      return validateResponse
    } catch (error) {
      console.log(`Error validating DDO: ${error}`)
      return { status: error.response.status, data: error.response.data }
    }
  }

  describe('Token Management Tests', () => {
    it('should create and validate token', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const consumerAddress = await consumerAccount.getAddress()
      const nonce = getRandomNonce()
      const message = auth.getMessage(consumerAddress, nonce)
      const messageHash = getMessageHash(message)
      const signature = await consumerAccount.signMessage(messageHash)

      const handlerResponse = await new CreateAuthTokenHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
        address: consumerAddress,
        signature,
        nonce
      })

      const token = await streamToObject(handlerResponse.stream as Readable)
      const testEndpointResponse = await ddoValiationRequest(token.token)
      expect(testEndpointResponse.status.httpStatus).to.equal(200)
    })

    it('should handle token expiry', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const consumerAddress = await consumerAccount.getAddress()
      const nonce = getRandomNonce()
      const message = auth.getMessage(consumerAddress, nonce)
      const messageHash = getMessageHash(message)
      const signature = await consumerAccount.signMessage(messageHash)

      const validUntil = Date.now() + 1000
      const handlerResponse = await new CreateAuthTokenHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
        address: consumerAddress,
        signature,
        nonce,
        validUntil
      })

      const token = await streamToObject(handlerResponse.stream as Readable)

      await new Promise((resolve) => setTimeout(resolve, 2000))

      const testEndpointResponse = await ddoValiationRequest(token.token)
      expect(testEndpointResponse.status.httpStatus).to.equal(401)
    })

    it('should invalidate token', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT)

      const consumerAddress = await consumerAccount.getAddress()
      const nonce = getRandomNonce()
      const message = auth.getMessage(consumerAddress, nonce)
      const messageHash = getMessageHash(message)
      const signature = await consumerAccount.signMessage(messageHash)

      const handlerResponse = await new CreateAuthTokenHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
        address: consumerAddress,
        signature,
        nonce
      })

      const token = await streamToObject(handlerResponse.stream as Readable)
      const newNonce = getRandomNonce()

      await new InvalidateAuthTokenHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.INVALIDATE_AUTH_TOKEN,
        address: consumerAddress,
        signature,
        nonce: newNonce,
        token: token.token
      })

      const testEndpointResponse = await ddoValiationRequest(token.token)
      expect(testEndpointResponse.status.httpStatus).to.equal(401)
    })

    describe('Error Cases', () => {
      it('should handle invalid signatures', async function () {
        this.timeout(DEFAULT_TEST_TIMEOUT)

        const consumerAddress = await consumerAccount.getAddress()

        const response = await new CreateAuthTokenHandler(oceanNode).handle({
          command: PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
          address: consumerAddress,
          signature: '0xinvalid',
          nonce: getRandomNonce()
        })
        expect(response.status.httpStatus).to.equal(401)
      })

      it('should handle invalid tokens', async function () {
        this.timeout(DEFAULT_TEST_TIMEOUT)

        const testEndpointResponse = await ddoValiationRequest('invalid-token')
        expect(testEndpointResponse.status.httpStatus).to.equal(401)
      })

      it('should handle missing parameters', async function () {
        this.timeout(DEFAULT_TEST_TIMEOUT)

        // Missing signature
        const response = await new CreateAuthTokenHandler(oceanNode).handle({
          command: PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
          address: await consumerAccount.getAddress(),
          signature: undefined,
          nonce: getRandomNonce()
        })
        expect(response.status.httpStatus).to.equal(400)

        // Missing address
        const nonce = getRandomNonce()
        const message = auth.getMessage(await consumerAccount.getAddress(), nonce)
        const messageHash = getMessageHash(message)
        const signature = await consumerAccount.signMessage(messageHash)

        const response2 = await new CreateAuthTokenHandler(oceanNode).handle({
          command: PROTOCOL_COMMANDS.CREATE_AUTH_TOKEN,
          address: undefined,
          signature,
          nonce: getRandomNonce()
        })
        expect(response2.status.httpStatus).to.equal(400)
      })
    })
  })
})
