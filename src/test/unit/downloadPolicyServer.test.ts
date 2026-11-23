import { expect } from 'chai'
import sinon from 'sinon'
import { deriveDid } from '@oceanprotocol/ddo-js'
import { DownloadHandler } from '../../components/core/handler/downloadHandler.js'
import { PolicyServer } from '../../components/policyServer/index.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

// The download handler accepts a service id or a service index. With a policy server
// configured, the access decision must name the service that is actually downloaded:
// before, the asset-level policy check sent the raw `serviceId` ('1'), and its approval
// then covered whichever service the index pointed to.

const CHAIN_ID = 8996
const NFT_ADDRESS = '0xBB1081DbF3227bbB233Db68f7117114baBb43656'
const CONSUMER = '0x0000000000000000000000000000000000000ABC'
const DID = deriveDid(NFT_ADDRESS, CHAIN_ID, '4')

const service = (id: string) => ({
  id,
  type: 'access',
  files: '0x',
  datatokenAddress: '0x0000000000000000000000000000000000000001',
  serviceEndpoint: 'http://localhost:8001',
  timeout: 0
})

const DDO = {
  '@context': ['https://w3id.org/did/v1'],
  id: DID,
  version: '4.1.0',
  chainId: CHAIN_ID,
  nftAddress: NFT_ADDRESS,
  metadata: { created: '', updated: '', type: 'dataset', name: 'x', author: 'x' },
  services: [service('public'), service('restricted')],
  credentials: { allow: [{ type: 'address', values: ['*'] }] },
  indexedMetadata: { nft: { state: 0 } }
}

function buildNode(): any {
  const blockchain = {
    isNetworkReady: () => Promise.resolve({ ready: true }),
    getProvider: () => Promise.resolve({}),
    getSigner: () => Promise.resolve({})
  }
  return {
    getRequestMap: () => new Map(),
    getConfig: () => ({
      rateLimit: undefined as number | undefined,
      supportedNetworks: { [CHAIN_ID]: { chainId: CHAIN_ID } }
    }),
    getAuth: () => ({
      validateAuthenticationOrToken: () =>
        Promise.resolve({ valid: true, error: '', address: CONSUMER })
    }),
    getCoreHandlers: () => ({
      getHandler: () => ({
        findAndFormatDdo: () => Promise.resolve(structuredClone(DDO))
      })
    }),
    getBlockchain: () => blockchain
  }
}

const downloadTask = (serviceId: string): any => ({
  command: PROTOCOL_COMMANDS.DOWNLOAD,
  fileIndex: 0,
  documentId: DID,
  serviceId,
  transferTxId: '0x01',
  consumerAddress: CONSUMER,
  nonce: '1',
  signature: '0xsignature'
})

describe('Download handler: policy server sees the downloaded service', () => {
  let envOverrides: OverrideEnvConfig[]
  let checkDownload: sinon.SinonStub

  before(async () => {
    envOverrides = await setupEnvironment(
      undefined,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.POLICY_SERVER_URL],
        ['http://localhost:9999']
      )
    )
  })

  beforeEach(() => {
    // Deny, so the handler stops right after the asset-level decision.
    checkDownload = sinon
      .stub(PolicyServer.prototype, 'checkDownload')
      .resolves({ success: false, message: 'denied', httpStatus: 403 })
  })

  afterEach(() => {
    sinon.restore()
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })

  it('sends the resolved service id when the service is selected by index', async () => {
    const result = await new DownloadHandler(buildNode()).handle(downloadTask('1'))
    expect(result.status.httpStatus).to.equal(403)
    expect(checkDownload.calledOnce).to.equal(true)
    expect(checkDownload.firstCall.args[2]).to.equal('restricted')
  })

  it('sends the service id when the service is selected by id', async () => {
    await new DownloadHandler(buildNode()).handle(downloadTask('public'))
    expect(checkDownload.firstCall.args[2]).to.equal('public')
  })

  it('rejects an unknown service before asking the policy server', async () => {
    let error: Error
    try {
      await new DownloadHandler(buildNode()).handle(downloadTask('missing'))
    } catch (e) {
      error = e
    }
    expect(error?.message).to.equal('Cannot find service')
    expect(checkDownload.called).to.equal(false)
  })
})
