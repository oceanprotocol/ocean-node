import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { errorSummary } from '../../../utils/logging/redact.js'
import {
  FreeComputeStartCommand,
  PaidComputeStartCommand
} from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import { OceanNode } from '../../../OceanNode.js'
import {
  bindAlgorithmContainerToDDO,
  generateUniqueID,
  getAlgoChecksums,
  validateAlgoForDataset,
  validateOutput,
  validateOutputBucket
} from './utils.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'
import {
  AssetUtils,
  getFilesObjectFromConfidentialEVM,
  isConfidentialChainDDO,
  isDataTokenTemplate4,
  isERC20Template4Active
} from '../../../utils/asset.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import {
  AlgoChecksums,
  ComputeAccessList,
  ComputeEnvironment,
  ComputeResourceRequestWithPrice
} from '../../../@types/C2D/C2D.js'
// import { verifyProviderFees } from '../utils/feesHandler.js'
import { validateOrderTransaction } from '../utils/validateOrders.js'
import { isPolicyServerConfigured } from '../../../utils/index.js'
import { sanitizeServiceFiles } from '../../../utils/util.js'
import { FindDdoHandler } from '../handler/ddoHandler.js'
// import { ProviderFeeValidation } from '../../../@types/Fees.js'
import { isOrderingAllowedForAsset } from '../handler/downloadHandler.js'
import { Credentials, DDOManager } from '@oceanprotocol/ddo-js'
import { getNonceAsNumber } from '../utils/nonceHandler.js'
import { PolicyServer } from '../../policyServer/index.js'
import { checkCredentials } from '../../../utils/credentials.js'
import { checkAddressOnAccessList } from '../../../utils/accessList.js'
import { ensureConsumerAllowedForPersistentStorageLocalfsFileObject } from '../../persistentStorage/PersistentStorageFactory.js'
import { resolveComputeFileObject } from '../../c2d/compute_engine_docker.js'
import { cJobsStarted } from '../../../telemetry/metrics.js'
import { resolveUserSubsidyProviders } from '../utils/subsidyProviders.js'
import { JobType } from '../../../utils/constants.js'

// Small helper so the many error short-circuits stay byte-identical across both
// handlers (same shape the originals returned: { stream: null, status: {...} }).
function buildComputeError(httpStatus: number, error: string): P2PCommandResponse {
  return {
    stream: null,
    status: {
      httpStatus,
      error
    }
  }
}

// Context handed to the paid-only per-asset order/payment hook.
interface AssetAuthorizationContext {
  elem: any
  ddo: any
  ddoInstance: any
  ddoChainId: any
  nftAddress: any
  service: any
  blockchain: any
}

interface AssetValidationOptions {
  policyServer: PolicyServer
  // The already-resolved algorithm DDO (from bindAndChecksumAlgorithm), reused for the
  // algorithm element so it is fetched exactly once across bind + checksums + this loop.
  algorithmDDO?: any
  // How the dataset serviceId used for validateAlgoForDataset is resolved. The paid
  // and free paths resolve this differently (kept identical to the pre-refactor code).
  datasetServiceId: (elem: any, ddoInstance: any) => string
  // Paid-only: validate the on-chain order (transferTxId + validateOrderTransaction)
  // for each published asset. Free compute has no orders, so it omits this hook.
  authorizeAsset?: (ctx: AssetAuthorizationContext) => Promise<P2PCommandResponse | null>
}

// CommonComputeHandler holds every step that the paid and free start handlers share.
// Each subclass's handle() orchestrates these building blocks in its own order (the two
// flows genuinely differ in ordering, try/catch boundaries, payment and access-list
// source), but the shared steps themselves - crucially the asset-validation + algorithm
// container binding loop - live here exactly once so the two paths can no longer drift.
export class CommonComputeHandler extends CommandHandler {
  validate(command: PaidComputeStartCommand): ValidateParams {
    return {
      valid: true
    }
  }

  // eslint-disable-next-line require-await
  async handle(task: PaidComputeStartCommand): Promise<P2PCommandResponse> {
    return null
  }

  // Hook: clamp maxJobDuration to the environment's limit. Paid uses env.maxJobDuration,
  // free uses env.free.maxJobDuration - subclasses MUST override this.
  protected applyMaxJobDuration(task: FreeComputeStartCommand, env: any): void {
    throw new Error('applyMaxJobDuration must be implemented by the subclass')
  }

  // verifyParamsAndRateLimits + queueMaxWaitTime default + token/signature auth gate.
  // Returns a response to short-circuit on, or null to continue. Identical in both flows.
  protected async prepareAndAuthorize(
    task: FreeComputeStartCommand
  ): Promise<P2PCommandResponse | null> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    if (!task.queueMaxWaitTime) {
      task.queueMaxWaitTime = 0
    }
    const authValidationResponse = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      task.command
    )
    if (authValidationResponse.status.httpStatus !== 200) {
      return authValidationResponse
    }
    return null
  }

  // Resolves the C2D engine for task.environment, unifying the duplicated
  // "Invalid C2D Environment" handling of both start handlers. `hash` is returned for
  // the jobs.started metric tag.
  protected async resolveEngine(
    task: FreeComputeStartCommand,
    node: OceanNode
  ): Promise<{ engine?: any; hash?: string; response?: P2PCommandResponse }> {
    // split compute env (which is already in hash-envId format) and get the hash
    // then get env which might contain dashes as well
    const eIndex = task.environment.indexOf('-')
    const hash = task.environment.slice(0, eIndex)
    let engine
    try {
      engine = await node.getC2DEngines().getC2DByHash(hash)
    } catch (e) {
      const errMsg = e?.message || String(e)
      CORE_LOGGER.error(`Invalid C2D Environment: ${errMsg}`)
      return { response: buildComputeError(500, 'Invalid C2D Environment') }
    }
    if (engine === null || engine === undefined) {
      return { response: buildComputeError(500, 'Invalid C2D Environment') }
    }
    return { engine, hash }
  }

  // getComputeEnvironments + find env + computeJobs feature gate. Intentionally has NO
  // internal try/catch: the caller decides how a getComputeEnvironments throw is mapped
  // (paid wraps it as a 400, free lets it fall through to the outer 500).
  protected async resolveEnvironment(
    task: FreeComputeStartCommand,
    engine: any
  ): Promise<{
    env?: ComputeEnvironment
    allEnvs?: ComputeEnvironment[]
    response?: P2PCommandResponse
  }> {
    const allEnvs: ComputeEnvironment[] = await engine.getComputeEnvironments()
    const env = allEnvs.find((e) => e.id === task.environment)
    if (!env) {
      return { response: buildComputeError(500, 'Invalid C2D Environment') }
    }
    if (env.features?.computeJobs === false) {
      return {
        response: buildComputeError(
          403,
          'Compute jobs are not enabled on this environment'
        )
      }
    }
    return { env, allEnvs }
  }

  // encryptedDockerRegistryAuth validation (identical in both flows).
  protected async validateDockerRegistryAuth(
    task: FreeComputeStartCommand,
    engine: any
  ): Promise<P2PCommandResponse | null> {
    // validate encrypteddockerRegistryAuth
    if (task.encryptedDockerRegistryAuth) {
      const validation = await engine.checkEncryptedDockerRegistryAuth(
        task.encryptedDockerRegistryAuth
      )
      if (!validation.valid) {
        return buildComputeError(
          validation.status,
          `Invalid encryptedDockerRegistryAuth :${validation.reason}`
        )
      }
    }
    return null
  }

  // validateOutputBucket + validateOutput (identical pair, called at different times).
  protected async validateOutputs(
    task: FreeComputeStartCommand,
    node: OceanNode
  ): Promise<P2PCommandResponse | null> {
    const isValidOutputBucket = await validateOutputBucket(
      node,
      task.outputBucketId,
      task.output,
      task.consumerAddress
    )
    if (isValidOutputBucket.status.httpStatus !== 200) {
      return isValidOutputBucket
    }
    const isValidOutput = await validateOutput(node, task.output, node.getConfig())
    if (isValidOutput.status.httpStatus !== 200) {
      return isValidOutput
    }
    return null
  }

  // Persistent-storage ACL loop over algorithm + datasets (identical in both flows).
  protected async checkPersistentStorageAcl(
    task: FreeComputeStartCommand,
    node: OceanNode
  ): Promise<P2PCommandResponse | null> {
    for (const elem of [task.algorithm, ...task.datasets]) {
      // resolve encrypted / documentId+serviceId references so persistent-storage ACL
      // is validated here too (not only plaintext file objects)
      const resolvedFileObject = (await resolveComputeFileObject(elem)) ?? elem.fileObject
      const psAccess = await ensureConsumerAllowedForPersistentStorageLocalfsFileObject(
        node,
        task.consumerAddress,
        resolvedFileObject
      )
      if (psAccess) {
        return psAccess
      }
    }
    return null
  }

  // Resolves the algorithm DDO ONCE, binds the algorithm container from it, and computes
  // the algorithm checksums from that SAME DDO. Shared by both start handlers (and mirrored
  // by initialize.ts) so:
  //  - the bind can never again be dropped from one path (the free-path regression),
  //  - the container that runs and the checksums validated come from one fetch / one DDO
  //    version (no cross-fetch drift),
  //  - the bind runs BEFORE any caller reads meta (e.g. the rawcode checksum gate), so a
  //    client meta.rawcode on a published algorithm cannot influence that gate.
  // Returns the resolved DDO so the asset-validation loop can reuse it instead of re-fetching,
  // and a `response` set to a 400 when the documentId cannot be bound to a usable published
  // algorithm - either it resolves to a NON-algorithm DDO or it does not resolve at all (so a
  // client-supplied container is never run under a documentId we cannot verify).
  protected async bindAndChecksumAlgorithm(
    task: FreeComputeStartCommand,
    node: OceanNode
  ): Promise<{
    algorithmDDO: any
    algoChecksums: AlgoChecksums
    response: P2PCommandResponse | null
  }> {
    const algorithmDDO = task.algorithm.documentId
      ? await new FindDdoHandler(node).findAndFormatDdo(task.algorithm.documentId)
      : null
    const outcome = await bindAlgorithmContainerToDDO(task.algorithm, node, algorithmDDO)
    if (outcome === 'invalid') {
      return {
        algorithmDDO,
        algoChecksums: { files: '', container: '', serviceId: task.algorithm.serviceId },
        response: buildComputeError(
          400,
          `Algorithm ${task.algorithm.documentId} is not a valid algorithm asset`
        )
      }
    }
    const algoChecksums = await getAlgoChecksums(
      task.algorithm.documentId,
      task.algorithm.serviceId,
      node,
      node.getConfig(),
      task.consumerAddress,
      algorithmDDO
    )
    return { algorithmDDO, algoChecksums, response: null }
  }

  // Paid-only gate: a non-raw algorithm must resolve both container and files checksums.
  protected enforceAlgoChecksums(
    task: FreeComputeStartCommand,
    algoChecksums: AlgoChecksums
  ): P2PCommandResponse | null {
    const isRawCodeAlgorithm = task.algorithm.meta?.rawcode
    const hasValidChecksums = algoChecksums.container && algoChecksums.files
    if (!isRawCodeAlgorithm && !hasValidChecksums) {
      const errorMessage =
        'Failed to retrieve algorithm checksums. Both container and files checksums are required.'
      CORE_LOGGER.debug(errorMessage)
      return buildComputeError(500, errorMessage)
    }
    return null
  }

  // checkIfResourcesAreAvailable + the shared queue-or-reject handling. Differs between
  // flows only by the isFree boolean and which env list is passed.
  protected async ensureResourcesAvailable(
    task: FreeComputeStartCommand,
    engine: any,
    env: ComputeEnvironment,
    isFree: boolean,
    allEnvs: ComputeEnvironment[]
  ): Promise<P2PCommandResponse | null> {
    try {
      await engine.checkIfResourcesAreAvailable(task.resources, env, isFree, allEnvs)
    } catch (e) {
      if (task.queueMaxWaitTime > 0) {
        // the job is queued, not failed: a busy node is normal
        CORE_LOGGER.debug(
          `Compute resources not available, queuing job for max ${task.queueMaxWaitTime} seconds`
        )
      } else {
        const errMsg = e?.message || String(e)
        CORE_LOGGER.error(`Error checking if resources are available: ${errMsg}`)
        return buildComputeError(400, e?.message || String(e))
      }
    }
    return null
  }

  // Emits the jobs.started metric (never throws out of the counter).
  protected emitJobStarted(hash: string, isFree: boolean): void {
    try {
      cJobsStarted.add(1, { engine: hash, free: isFree ? 'true' : 'false' })
    } catch (e: any) {
      CORE_LOGGER.error(`[metrics] jobs.started counter failed: ${e?.message}`)
    }
  }

  // Shared asset-validation loop over [algorithm, ...datasets]. For every published asset
  // it resolves the DDO, checks ordering/credentials/decryptability, and - for datasets -
  // that the algorithm is trusted. The algorithm container was already bound to its DDO by
  // bindAndChecksumAlgorithm (shared by both handlers), and the algorithm's DDO resolved
  // there is reused here via options.algorithmDDO so the algorithm is fetched exactly once.
  protected async validateAssets(
    task: FreeComputeStartCommand,
    node: OceanNode,
    algoChecksums: AlgoChecksums,
    options: AssetValidationOptions
  ): Promise<P2PCommandResponse | null> {
    const { policyServer } = options
    for (const elem of [task.algorithm, ...task.datasets]) {
      if (!('documentId' in elem) || !elem.documentId) {
        continue
      }
      // Reuse the algorithm DDO already fetched (bind + checksums) instead of re-fetching.
      const ddo =
        options.algorithmDDO && elem.documentId === task.algorithm.documentId
          ? options.algorithmDDO
          : await new FindDdoHandler(node).findAndFormatDdo(elem.documentId)
      if (!ddo) {
        return buildComputeError(500, `DDO ${elem.documentId} not found`)
      }
      const ddoInstance = DDOManager.getDDOClass(ddo)
      const {
        chainId: ddoChainId,
        metadata,
        nftAddress,
        credentials
      } = ddoInstance.getDDOFields()
      const isOrdable = isOrderingAllowedForAsset(ddo)
      if (!isOrdable.isOrdable) {
        CORE_LOGGER.debug(
          `Asset ${ddoInstance.getDid()} not orderable: ${isOrdable.reason}`
        )
        return buildComputeError(500, isOrdable.reason)
      }
      const config = node.getConfig()
      const { chainId } = config.supportedNetworks[ddoChainId]

      const blockchain = node.getBlockchain(chainId)
      if (!blockchain) {
        return buildComputeError(
          400,
          `Start Compute: Blockchain instance not available for chain ${chainId}`
        )
      }
      const { ready, error } = await blockchain.isNetworkReady()
      if (!ready) {
        return buildComputeError(400, `Start Compute : ${error}`)
      }

      // check credentials (DDO level)
      let accessGrantedDDOLevel: boolean
      if (credentials) {
        // if POLICY_SERVER_URL exists, then ocean-node will NOT perform any checks.
        // It will just use the existing code and let PolicyServer decide.
        if (isPolicyServerConfigured()) {
          const response = await policyServer.checkStartCompute(
            ddoInstance.getDid(),
            ddo,
            elem.serviceId,
            task.consumerAddress,
            task.policyServer
          )
          accessGrantedDDOLevel = response.success
        } else {
          accessGrantedDDOLevel = await checkCredentials(
            task.consumerAddress,
            credentials as Credentials,
            await blockchain.getSigner()
          )
        }
        if (!accessGrantedDDOLevel) {
          CORE_LOGGER.debug(
            `Access to asset ${ddoInstance.getDid()} denied for ${task.consumerAddress}`
          )
          return buildComputeError(
            403,
            `Error: Access to asset ${ddoInstance.getDid()} was denied`
          )
        }
      }
      const service = AssetUtils.getServiceById(ddo, elem.serviceId)
      if (!service) {
        return buildComputeError(
          500,
          `Cannot find service ${elem.serviceId} in DDO ${elem.documentId}`
        )
      }
      // check credentials on service level
      // if using a policy server and we are here it means that access was granted (they are merged/assessed together)
      if (service.credentials) {
        let accessGrantedServiceLevel: boolean
        if (isPolicyServerConfigured()) {
          // we use the previous check or we do it again
          // (in case there is no DDO level credentials and we only have Service level ones)
          const response = await policyServer.checkStartCompute(
            ddoInstance.getDid(),
            ddo,
            service.id,
            task.consumerAddress,
            task.policyServer
          )
          accessGrantedServiceLevel = accessGrantedDDOLevel || response.success
        } else {
          accessGrantedServiceLevel = await checkCredentials(
            task.consumerAddress,
            service.credentials,
            await blockchain.getSigner()
          )
        }

        if (!accessGrantedServiceLevel) {
          CORE_LOGGER.debug(
            `Access to service ${service.id} denied for ${task.consumerAddress}`
          )
          return buildComputeError(
            403,
            `Error: Access to service with id ${service.id} was denied`
          )
        }
      }

      // let's see if we can access this asset
      // check if oasis evm or similar
      const confidentialEVM = isConfidentialChainDDO(BigInt(ddoChainId), service)
      let canDecrypt = false
      try {
        if (!confidentialEVM) {
          await node
            .getKeyManager()
            .decrypt(
              Uint8Array.from(Buffer.from(sanitizeServiceFiles(service.files), 'hex')),
              EncryptMethod.ECIES
            )
          canDecrypt = true
        } else {
          // TODO 'Start compute on confidential EVM!'
          const signer = await blockchain.getSigner()
          const isTemplate4 = await isDataTokenTemplate4(service.datatokenAddress, signer)
          if (isTemplate4 && (await isERC20Template4Active(ddoChainId, signer))) {
            // we need to get the proper data for the signature
            const consumeData =
              task.consumerAddress +
              task.datasets[0].documentId +
              (await getNonceAsNumber(task.consumerAddress))
            // call smart contract to decrypt
            const serviceIndex = AssetUtils.getServiceIndexById(ddo, service.id)
            const filesObject = await getFilesObjectFromConfidentialEVM(
              serviceIndex,
              service.datatokenAddress,
              signer,
              task.consumerAddress,
              task.signature, // we will need to have a signature verification
              consumeData
            )
            if (filesObject != null) {
              canDecrypt = true
            }
          }
        }
      } catch (e) {
        // do nothing
        // errorSummary: a JSON.parse error would quote the decrypted files object
        CORE_LOGGER.error(`Could not decrypt DDO files Object: ${errorSummary(e)}`)
      }
      if (service.type === 'compute' && !canDecrypt) {
        return buildComputeError(
          500,
          `Service ${elem.serviceId} from DDO ${elem.documentId} cannot be used in compute on this provider`
        )
      }
      if (metadata.type !== 'algorithm') {
        const validAlgoForDataset = await validateAlgoForDataset(
          task.algorithm.documentId,
          algoChecksums,
          ddoInstance,
          options.datasetServiceId(elem, ddoInstance),
          node
        )
        if (!validAlgoForDataset) {
          return buildComputeError(
            400,
            `Algorithm ${
              task.algorithm.documentId
            } not allowed to run on the dataset: ${ddoInstance.getDid()}`
          )
        }
      }

      // paid-only: validate the on-chain order (transferTxId + validateOrderTransaction)
      if (options.authorizeAsset) {
        const orderResponse = await options.authorizeAsset({
          elem,
          ddo,
          ddoInstance,
          ddoChainId,
          nftAddress,
          service,
          blockchain
        })
        if (orderResponse) {
          return orderResponse
        }
      }
    }
    return null
  }
}

export class PaidComputeStartHandler extends CommonComputeHandler {
  validate(command: PaidComputeStartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'environment',
      'algorithm',
      'datasets',
      'maxJobDuration'
    ])
    if (commandValidation.valid) {
      if (!isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
      if (parseInt(String(command.maxJobDuration)) <= 0) {
        return buildInvalidRequestMessage('Invalid maxJobDuration')
      }
    }
    return commandValidation
  }

  protected applyMaxJobDuration(task: PaidComputeStartCommand, env: any): void {
    if (!task.maxJobDuration || task.maxJobDuration > env.maxJobDuration) {
      task.maxJobDuration = env.maxJobDuration
    }
  }

  async handle(task: PaidComputeStartCommand): Promise<P2PCommandResponse> {
    const authResponse = await this.prepareAndAuthorize(task)
    if (authResponse) {
      return authResponse
    }
    const node = this.getOceanNode()
    try {
      const {
        engine,
        hash,
        response: engineResponse
      } = await this.resolveEngine(task, node)
      if (engineResponse) {
        return engineResponse
      }

      let env: ComputeEnvironment
      let allEnvs: ComputeEnvironment[]
      try {
        const envResult = await this.resolveEnvironment(task, engine)
        if (envResult.response) {
          return envResult.response
        }
        ;({ env, allEnvs } = envResult)
        this.applyMaxJobDuration(task, env)
        task.resources = await engine.checkAndFillMissingResources(
          task.resources,
          env,
          false
        )
      } catch (e) {
        const errMsg = e?.message || String(e)
        CORE_LOGGER.error(`Error checking and filling missing resources: ${errMsg}`)
        return buildComputeError(400, errMsg)
      }

      const resourcesResponse = await this.ensureResourcesAvailable(
        task,
        engine,
        env,
        false,
        allEnvs
      )
      if (resourcesResponse) {
        return resourcesResponse
      }

      const dockerAuthResponse = await this.validateDockerRegistryAuth(task, engine)
      if (dockerAuthResponse) {
        return dockerAuthResponse
      }

      const { algorithm } = task

      const accessGranted = await validateAccess(
        task.consumerAddress,
        env.access,
        this.getOceanNode()
      )
      if (!accessGranted) {
        return buildComputeError(403, 'Access denied')
      }

      const psResponse = await this.checkPersistentStorageAcl(task, node)
      if (psResponse) {
        return psResponse
      }

      // ACL preflight is confirmed above before attempting checksum retrieval,
      // so unauthorized consumers get an explicit ACL denial instead of a generic 500.
      // bindAndChecksumAlgorithm resolves the algo DDO once, binds the container from it
      // (BEFORE the rawcode gate below reads meta), and computes checksums from that DDO.
      const {
        algorithmDDO,
        algoChecksums,
        response: bindResponse
      } = await this.bindAndChecksumAlgorithm(task, node)
      if (bindResponse) {
        return bindResponse
      }
      const checksumResponse = this.enforceAlgoChecksums(task, algoChecksums)
      if (checksumResponse) {
        return checksumResponse
      }

      const policyServer = new PolicyServer()
      const assetsResponse = await this.validateAssets(task, node, algoChecksums, {
        policyServer,
        algorithmDDO,
        datasetServiceId: (elem, ddoInstance) => {
          const index = task.datasets.findIndex(
            (d) => d.documentId === ddoInstance.getDid()
          )
          const safeIndex = index === -1 ? 0 : index
          return task.datasets[safeIndex].serviceId
        },
        authorizeAsset: async ({
          elem,
          ddo,
          ddoChainId,
          nftAddress,
          service,
          blockchain
        }) => {
          const provider = await blockchain.getProvider()

          if (!('transferTxId' in elem) || !elem.transferTxId) {
            return buildComputeError(
              500,
              `Missing transferTxId for DDO ${elem.documentId}`
            )
          }

          // search for that compute env and see if it has access to dataset
          // Option B (env-AND): the order's consumer must be this env (so the node can
          // retrieve/decrypt the dataset, incl. from a remote encrypting node) AND the
          // order's payer must be the signature-verified caller (the reuse-vuln fix).
          const paymentValidation = await validateOrderTransaction(
            elem.transferTxId,
            env.consumerAddress,
            provider,
            nftAddress,
            service.datatokenAddress,
            AssetUtils.getServiceIndexById(ddo, service.id),
            service.timeout,
            await blockchain.getSigner(),
            task.consumerAddress
          )
          if (paymentValidation.isValid === false) {
            return buildComputeError(
              500,
              `TxId Service ${elem.transferTxId} is not valid for DDO ${elem.documentId} and service ${service.id}`
            )
          }
          return null
        }
      })
      if (assetsResponse) {
        return assetsResponse
      }

      // let's lock the amount
      const prices = engine.getEnvPricesForToken(
        env,
        task.payment.chainId,
        task.payment.token
      )
      if (!prices) {
        return buildComputeError(
          500,
          `This compute env does not accept payments on chain: ${task.payment.chainId} using token ${task.payment.token}`
        )
      }
      const resources: ComputeResourceRequestWithPrice[] = []

      for (const res of task.resources) {
        const price = engine.getResourcePrice(prices, res.id)
        resources.push({
          id: res.id,
          amount: res.amount,
          price
        })
      }
      const s = {
        assets: task.datasets,
        algorithm,
        output: task.output,
        environment: env.id,
        owner: task.consumerAddress,
        maxJobDuration: task.maxJobDuration,
        chainId: task.payment.chainId,
        agreementId: '',
        resources,
        metadata: task.metadata
      }
      // job ID unicity
      const jobId = generateUniqueID(s)
      // let's calculate payment needed based on resources request and maxJobDuration
      const cost = engine.calculateResourcesCost(
        task.resources,
        env,
        task.payment.chainId,
        task.payment.token,
        task.maxJobDuration
      )
      // Resolve the user-supplied subsidy providers (if any) for the payment chain, enforcing the
      // node's whitelist filter when enabled. Done before locking funds so a bad list fails fast;
      // the resolved value is persisted on the job so the (batched) claim later uses the user's
      // choice rather than whatever the node config holds at claim time.
      const subsidyResolution = resolveUserSubsidyProviders(
        task.subsidyProviders,
        task.payment.chainId,
        node.getConfig()
      )
      if (!subsidyResolution.valid) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: subsidyResolution.reason
          }
        }
      }
      // Snapshot the EFFECTIVE provider list now and reuse the SAME array for both the lock and the
      // (batched) claim, so they can never disagree. An explicit user list is used as-is; when the
      // user opted out (`resolved === undefined`) we snapshot the node's configured list for this
      // chain AT LOCK TIME, rather than letting the lock and the much-later claim each re-read
      // SUBSIDY_PROVIDERS live — for a prefunded lock those two live reads could straddle an
      // operator config change and settle the claim against a different provider set than the lock
      // was funded from. `??` (not `||`) so an explicit `[]` (no providers) survives.
      const effectiveSubsidy =
        subsidyResolution.resolved ??
        node.getConfig().subsidyProviders?.[String(task.payment.chainId)] ??
        []
      let agreementId
      CORE_LOGGER.debug(
        `escrow.createLock job=${jobId} cost=${cost} token=${task.payment.token} chainId=${task.payment.chainId} maxJobDuration=${task.maxJobDuration}`
      )
      try {
        agreementId = await engine.escrow.createLock(
          task.payment.chainId,
          jobId,
          task.payment.token,
          task.consumerAddress,
          cost,
          engine.escrow.getMinLockTime(
            Number(task.maxJobDuration) + Number(task.queueMaxWaitTime)
          ),
          JobType.COMPUTE,
          // The snapshotted list, also persisted on the job (below) and handed to claimLock —
          // lock & claim settle from the exact same provider set.
          effectiveSubsidy
        )
      } catch (e) {
        const errMsg = e?.message || String(e)
        CORE_LOGGER.error(
          `Error creating lock for job ${hash}-${jobId} (chain ${task.payment.chainId}): ${errMsg}`
        )
        if (e.message.includes('insufficient funds for intrinsic transaction cost')) {
          return buildComputeError(
            400,
            'Node insufficient gas funds. If you are the node owner, please add gas funds to the node.'
          )
        }
        return buildComputeError(400, e?.message || String(e))
      }
      const isValidOutput = await this.validateOutputs(task, node)
      if (isValidOutput) {
        return isValidOutput
      }
      try {
        const response = await engine.startComputeJob(
          task.datasets,
          algorithm,
          task.output,
          env.id,
          task.consumerAddress,
          task.maxJobDuration,
          task.resources,
          {
            chainId: task.payment.chainId,
            token: task.payment.token,
            lockTx: agreementId,
            claimTx: null,
            cancelTx: null,
            cost: 0,
            subsidyProviders: effectiveSubsidy
          },
          jobId,
          task.metadata,
          task.additionalViewers,
          task.queueMaxWaitTime,
          task.encryptedDockerRegistryAuth,
          task.outputBucketId
        )
        if (response?.length > 0) {
          CORE_LOGGER.info(
            `Compute job created: ${hash}-${jobId} env=${task.environment} owner=${task.consumerAddress} chain=${task.payment.chainId} lockTx=${agreementId}`
          )
        } else {
          CORE_LOGGER.error(
            `Compute job ${hash}-${jobId} was not created (engine returned no job); lock ${agreementId} remains on chain ${task.payment.chainId} for ${task.consumerAddress}`
          )
        }
        this.emitJobStarted(hash, false)

        return {
          stream: Readable.from(JSON.stringify(response)),
          status: {
            httpStatus: 200
          }
        }
      } catch (e) {
        const errMsg = e?.message || String(e)
        CORE_LOGGER.error(
          `Compute job ${hash}-${jobId} failed to start after lock ${agreementId} (payer ${task.consumerAddress}, chain ${task.payment.chainId}): ${errMsg.slice(0, 300)}`
        )
        try {
          await engine.escrow.cancelExpiredLock(
            task.payment.chainId,
            jobId,
            task.payment.token,
            task.consumerAddress
          )
        } catch (cancelError) {
          const cancelErrMsg = cancelError?.message || String(cancelError)
          CORE_LOGGER.error(
            `Error canceling expired locks for job ${hash}-${jobId} (lockTx ${agreementId}, payer ${task.consumerAddress}, chain ${task.payment.chainId}): ${cancelErrMsg}`
          )
          // is fine if it fails
        }
        return buildComputeError(400, e?.message || String(e))
      }
    } catch (error) {
      const errMsg = error?.message || String(error)
      CORE_LOGGER.error(`Paid compute start failed: ${errMsg.slice(0, 300)}`)
      return buildComputeError(500, error.message)
    }
  }
}

export class FreeComputeStartHandler extends CommonComputeHandler {
  validate(command: FreeComputeStartCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'algorithm',
      'datasets',
      'environment'
    ])
    if (commandValidation.valid) {
      if (!isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
    }
    return commandValidation
  }

  protected applyMaxJobDuration(task: FreeComputeStartCommand, env: any): void {
    if (!task.maxJobDuration || task.maxJobDuration > env.free.maxJobDuration) {
      task.maxJobDuration = env.free.maxJobDuration
    }
  }

  async handle(task: FreeComputeStartCommand): Promise<P2PCommandResponse> {
    const authResponse = await this.prepareAndAuthorize(task)
    if (authResponse) {
      return authResponse
    }
    const node = this.getOceanNode()
    try {
      const {
        engine,
        hash,
        response: engineResponse
      } = await this.resolveEngine(task, node)
      if (engineResponse) {
        return engineResponse
      }

      const dockerAuthResponse = await this.validateDockerRegistryAuth(task, engine)
      if (dockerAuthResponse) {
        return dockerAuthResponse
      }

      const isValidOutput = await this.validateOutputs(task, node)
      if (isValidOutput) {
        return isValidOutput
      }

      const psResponse = await this.checkPersistentStorageAcl(task, node)
      if (psResponse) {
        return psResponse
      }

      const {
        algorithmDDO,
        algoChecksums,
        response: bindResponse
      } = await this.bindAndChecksumAlgorithm(task, node)
      if (bindResponse) {
        return bindResponse
      }

      // Resolve the environment before validateAssets so env.consumerAddress is available
      // to the free authorizeAsset callback (the order's required consumer under Option B).
      // Only the position of this resolve moves up; the validateAccess / resources steps
      // below still run in their original order.
      const envResult = await this.resolveEnvironment(task, engine)
      if (envResult.response) {
        return envResult.response
      }
      const { env } = envResult
      const allFreeEnvs = envResult.allEnvs

      const policyServer = new PolicyServer()
      const assetsResponse = await this.validateAssets(task, node, algoChecksums, {
        policyServer,
        algorithmDDO,
        datasetServiceId: (elem) => elem.serviceId,
        // Free compute may reference a paid asset. Omitting transferTxId runs it free
        // without an order (intended, allowed) - skip. If a transferTxId IS supplied it is
        // validated with Option B (env-AND) so a reused/foreign order is rejected here too.
        authorizeAsset: async ({ elem, ddo, nftAddress, service, blockchain }) => {
          if (!('transferTxId' in elem) || !elem.transferTxId) {
            return null
          }
          const provider = await blockchain.getProvider()
          const paymentValidation = await validateOrderTransaction(
            elem.transferTxId,
            env.consumerAddress,
            provider,
            nftAddress,
            service.datatokenAddress,
            AssetUtils.getServiceIndexById(ddo, service.id),
            service.timeout,
            await blockchain.getSigner(),
            task.consumerAddress
          )
          if (paymentValidation.isValid === false) {
            return buildComputeError(
              500,
              `TxId Service ${elem.transferTxId} is not valid for DDO ${elem.documentId} and service ${service.id}`
            )
          }
          return null
        }
      })
      if (assetsResponse) {
        return assetsResponse
      }

      try {
        const accessGranted = await validateAccess(
          task.consumerAddress,
          env.free.access,
          this.getOceanNode()
        )
        if (!accessGranted) {
          return buildComputeError(403, 'Access denied')
        }

        task.resources = await engine.checkAndFillMissingResources(
          task.resources,
          env,
          true
        )

        this.applyMaxJobDuration(task, env)
      } catch (e) {
        CORE_LOGGER.error(`Free compute request rejected: ${e?.message || String(e)}`)
        return buildComputeError(400, String(e))
      }

      const resourcesResponse = await this.ensureResourcesAvailable(
        task,
        engine,
        env,
        true,
        allFreeEnvs
      )
      if (resourcesResponse) {
        return resourcesResponse
      }

      const s = {
        assets: task.datasets,
        algorithm: task.algorithm,
        output: task.output,
        environment: task.environment,
        owner: task.consumerAddress,
        maxJobDuration: task.maxJobDuration,
        resources: task.resources,
        metadata: task.metadata
      }
      const jobId = generateUniqueID(s)
      const response = await engine.startComputeJob(
        task.datasets,
        task.algorithm,
        task.output,
        task.environment,
        task.consumerAddress,
        task.maxJobDuration,
        task.resources,
        null,
        jobId,
        task.metadata,
        task.additionalViewers,
        task.queueMaxWaitTime,
        task.encryptedDockerRegistryAuth,
        task.outputBucketId
      )

      if (response?.length > 0) {
        CORE_LOGGER.info(
          `Free compute job created: ${hash}-${jobId} env=${task.environment} owner=${task.consumerAddress}`
        )
      } else {
        CORE_LOGGER.error(
          `Free compute job ${hash}-${jobId} was not created (engine returned no job)`
        )
      }
      this.emitJobStarted(hash, true)

      return {
        stream: Readable.from(JSON.stringify(response)),
        status: {
          httpStatus: 200
        }
      }
    } catch (error) {
      CORE_LOGGER.error(
        `Free compute start failed: ${String(error?.message).slice(0, 300)}`
      )
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: error.message
        }
      }
    }
  }
}

export async function validateAccess(
  consumerAddress: string,
  access: ComputeAccessList | undefined,
  oceanNode: OceanNode
): Promise<boolean> {
  if (!access) {
    return true
  }

  if (
    !access.accessLists ||
    (access.accessLists.length === 0 && access.addresses.length === 0)
  ) {
    return true
  }

  if (access.addresses.includes(consumerAddress)) {
    return true
  }
  return await checkAddressOnAccessList(consumerAddress, access.accessLists, oceanNode)
}
