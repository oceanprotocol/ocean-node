import { assert } from 'chai'
import { JsonRpcProvider, Signer, sha256, toUtf8Bytes } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { RPCS } from '../../@types/blockchain.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment
} from '../utils/utils.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import axios, { AxiosResponse } from 'axios'

describe('Should run a complete node flow.', async () => {
  let config: OceanNodeConfig
  let database: Database
  //  eslint-disable-next-line no-unused-vars
  let previousConfiguration: OverrideEnvConfig[]

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const provider = new JsonRpcProvider('http://127.0.0.1:8545')

  const publisherAccount = (await provider.getSigner(0)) as Signer
  const consumerAccount = (await provider.getSigner(1)) as Signer
  const consumerAddress = await consumerAccount.getAddress()
  const publisherAddress = await publisherAccount.getAddress()

  before(async () => {
    // override and save configuration (always before calling getConfig())
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.DB_URL,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS,
          ENVIRONMENT_VARIABLES.HTTP_API_PORT
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify([publisherAddress, consumerAddress]),
          8081
        ]
      )
    )
    config = await getConfiguration(true)
    database = await new Database(config.dbConfig)

    //  eslint-disable-next-line no-unused-vars
    const indexer = new OceanIndexer(database, mockSupportedNetworks)

    let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!network) {
      network = getOceanArtifactsAdresses().development
    }
  })

  it('should authenticate as admin', async () => {
    const oceanNodeConfig = await getConfiguration(true)
    const nonce = 1
    const currentDate = new Date()
    const expiryTimestamp = new Date(
      currentDate.getFullYear() + 1,
      currentDate.getMonth(),
      currentDate.getDate()
    ).getTime()

    const message = sha256(
      toUtf8Bytes(nonce.toString() + '-' + expiryTimestamp.toString())
    )

    // Sign the original message directly
    const signature = await publisherAccount.signMessage(message)

    const payload: any = {
      nonce,
      expiryTimestamp,
      signature
    }
    const response: AxiosResponse = await axios.post(
      `http://localhost:${oceanNodeConfig.httpPort}/admin/auth`,
      payload
    )
    assert(response.status === 200, 'http status not 200')
    console.log(`response dataix: ${JSON.stringify(response.data)}`)
    // assert(response.data.response === true)
  })
})
