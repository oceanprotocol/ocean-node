import { Readable } from 'stream'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput,
  DBComputeJob
} from '../../@types/C2D/C2D.js'
import type {
  OPFK8ComputeStage,
  OPFK8ComputeStageAlgorithm,
  OPFK8ComputeStageInput,
  OPFK8ComputeWorkflow,
  OPFK8ComputeStart,
  OPFK8ComputeStop,
  OPFK8ComputeGetStatus,
  OPFK8ComputeGetResult
} from '../../@types/C2D/C2D_OPFK8.js'
import { sign } from '../core/utils/nonceHandler.js'
import axios from 'axios'
import { getConfiguration } from '../../utils/config.js'
import { ZeroAddress } from 'ethers'
import { getProviderFeeToken } from '../../components/core/utils/feesHandler.js'
import { URLUtils } from '../../utils/url.js'
import { C2DEngine } from './compute_engine_base.js'
import { Storage } from '../storage/index.js'
export class C2DEngineOPFK8 extends C2DEngine {
  // eslint-disable-next-line no-useless-constructor
  public constructor(clusterConfig: C2DClusterInfo) {
    super(clusterConfig, null)
  }

  public override async getComputeEnvironments(
    chainId?: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */
    const envs: ComputeEnvironment[] = []
    const clusterHash = this.getC2DConfig().hash
    const baseUrl = URLUtils.sanitizeURLPath(this.getC2DConfig().connection)
    let url = `${baseUrl}api/v1/operator/environments`
    if (chainId) url += `?chain_id=${chainId}`
    try {
      const { data } = await axios.get(url)
      if (!data) return envs
      // we need to add hash to each env id
      for (const [index, val] of data.entries()) {
        data[index].id = `${clusterHash}-${val.id}`
        // k8 envs are not free envs
        data[index].free = false
        if (!data[index].feeToken || data[index].feeToken?.toLowerCase() === ZeroAddress)
          data[index].feeToken = await getProviderFeeToken(chainId)
        // also add chain id here, since it can be helpful
        if (chainId) data.chainId = chainId
      }
      return data
    } catch {}
    return envs
  }

  public override async startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    environment: string,
    owner?: string,
    validUntil?: number,
    chainId?: number,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    // owner, validUntil,chainId, agreementId are not optional for OPF K8
    if (!owner) throw new Error(`Cannot start a c2d job without owner`)
    if (!validUntil) throw new Error(`Cannot start a c2d job without validUntil`)
    if (!chainId) throw new Error(`Cannot start a c2d job without chainId`)
    if (!agreementId) throw new Error(`Cannot start a c2d job without agreementId`)
    // let's build the stage first
    // start with stage.input
    const config = await getConfiguration()
    const stagesInput: OPFK8ComputeStageInput[] = []
    let index = 0
    for (const asset of assets) {
      // TODO: we do not have a way (from CLI/SDK) to set this fileObject unencrypted
      // Previously we had "url" property but that was never used anywhere for the same reason (we used "remote")
      // we don't have the "url" anymore once we publish
      if (asset.fileObject) {
        try {
          // since opf k8 supports only urls, we need to extract them
          const storage = Storage.getStorageClass(asset.fileObject, config)
          stagesInput.push({
            index,
            url: [storage.getDownloadUrl()]
          })
        } catch (e) {
          const message = `Exception on startCompute. Cannot get URL of asset`
          throw new Error(message)
        }
      } else
        stagesInput.push({
          index,
          id: asset.documentId,
          remote: {
            txId: asset.transferTxId,
            serviceId: asset.serviceId,
            userdata: asset.userdata ? asset.userdata : {}
          }
        })
      index++
    }
    let getOuput = {}
    if (output) {
      getOuput = output
    } else if (config.hasHttp && config.c2dNodeUri) {
      getOuput = {
        metadataUri: config.c2dNodeUri
      }
    }
    // continue with algorithm
    const stageAlgorithm: OPFK8ComputeStageAlgorithm = {}

    // TODO: we do not have a way (from CLI/SDK) to set this fileObject unencrypted
    if (algorithm.fileObject) {
      try {
        // since opf k8 supports only urls, we need to extract them
        const storage = Storage.getStorageClass(algorithm.fileObject, config)
        stageAlgorithm.url = storage.getDownloadUrl()
      } catch (e) {
        const message = `Exception on startCompute. Cannot get URL of asset`
        throw new Error(message)
      }
    } else {
      stageAlgorithm.remote = {
        txId: algorithm.transferTxId,
        serviceId: algorithm.serviceId,
        userdata: algorithm.userdata ? algorithm.userdata : {}
      }
    }
    if (algorithm.documentId) stageAlgorithm.id = algorithm.documentId
    if ('meta' in algorithm && 'rawcode' in algorithm.meta && algorithm.meta.rawcode)
      stageAlgorithm.rawcode = algorithm.meta.rawcode
    if ('meta' in algorithm && 'container' in algorithm.meta && algorithm.meta.container)
      stageAlgorithm.container = algorithm.meta.container
    const stage: OPFK8ComputeStage = {
      index: 0,
      input: stagesInput,
      algorithm: stageAlgorithm,
      output: getOuput,
      compute: {
        Instances: 1,
        namespace: environment,
        maxtime: 3600
      }
    }
    // now, let's build the workflow
    const workflow: OPFK8ComputeWorkflow = {
      stages: [stage]
    }
    // and the full payload
    const nonce: number = new Date().getTime()
    const providerSignature = await sign(String(nonce), config.keys.privateKey)
    const payload: OPFK8ComputeStart = {
      workflow,
      owner,
      providerSignature,
      providerAddress: config.keys.ethAddress,
      environment,
      validUntil,
      nonce,
      agreementId,
      chainId
    }
    // and send it to remote op-service

    try {
      const response = await axios({
        method: 'post',
        url: `${URLUtils.sanitizeURLPath(
          this.getC2DConfig().connection
        )}api/v1/operator/compute`,
        data: payload
      })
      if (response.status !== 200) {
        const message = `Exception on startCompute. Status: ${response.status}, ${response.statusText}`
        throw new Error(message)
      }
      const jobs: ComputeJob[] = response.data
      const newResponse = JSON.parse(JSON.stringify(jobs)) as ComputeJob[]
      const { hash } = this.getC2DConfig()
      // we need to prepend cluster hash to each jobId
      for (let i = 0; i < jobs.length; i++) {
        newResponse[i].jobId = hash + '-' + jobs[i].jobId
      }
      return newResponse
    } catch (e) {}
    throw new Error(`startCompute Failure`)
  }

  public override async stopComputeJob(
    jobId: string,
    owner: string,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    // and the full payload
    const nonce: number = new Date().getTime()
    const config = await getConfiguration()
    // current provider (python) signature is owner + job_id + nonce OR owner + nonce
    const providerSignature = await sign(String(nonce), config.keys.privateKey)
    const payload: OPFK8ComputeStop = {
      owner,
      providerSignature,
      providerAddress: config.keys.ethAddress,
      nonce,
      jobId,
      agreementId
    }
    try {
      const response = await axios({
        method: 'put',
        url: `${URLUtils.sanitizeURLPath(
          this.getC2DConfig().connection
        )}api/v1/operator/compute`,
        data: payload
      })
      if (response.status !== 200) {
        const message = `Exception on stopCompute. Status: ${response.status}, ${response.statusText}`
        throw new Error(message)
      }
      return response.data
    } catch (e) {}
    throw new Error(`stopCompute Failure`)
  }

  public override async getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]> {
    const nonce: number = new Date().getTime()
    const config = await getConfiguration()
    let message: string
    if (jobId) message = String(nonce + consumerAddress + jobId)
    else message = String(nonce + consumerAddress + jobId)
    const providerSignature = await sign(message, config.keys.privateKey)

    const payload: OPFK8ComputeGetStatus = {
      providerSignature,
      providerAddress: config.keys.ethAddress,
      nonce,
      owner: consumerAddress,
      agreementId,
      jobId
    }
    try {
      const response = await axios({
        method: 'get',
        url: `${URLUtils.sanitizeURLPath(
          this.getC2DConfig().connection
        )}api/v1/operator/compute`,
        data: payload
      })
      if (response.status !== 200) {
        // do not throw, just return []
        return []
      }

      return response.data
    } catch (e) {
      console.error(e)
    }
    throw new Error(`getComputeJobStatus Failure`)
  }

  public override async getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number
  ): Promise<Readable> {
    const nonce: number = new Date().getTime()
    const config = await getConfiguration()
    // signature check on operator service is only owner + jobId
    // nonce is not part of signature message
    const message: string = jobId
      ? String(consumerAddress + jobId)
      : String(consumerAddress)
    const providerSignature = await sign(message, config.keys.privateKey)

    const payload: OPFK8ComputeGetResult = {
      providerSignature,
      providerAddress: config.keys.ethAddress,
      nonce,
      owner: consumerAddress,
      jobId,
      index
    }
    try {
      const response = await axios({
        method: 'get',
        url: `${URLUtils.sanitizeURLPath(
          this.getC2DConfig().connection
        )}api/v1/operator/getResult`,
        data: payload,
        responseType: 'stream'
      })
      if (response.status !== 200) {
        const message = `Exception on getComputeJobResult. Status: ${response.status}, ${response.statusText}`
        throw new Error(message)
      }
      return response.data
    } catch (e) {
      console.error(e)
    }
    throw new Error(`getComputeJobStatus Failure`)
  }

  // eslint-disable-next-line require-await
  public override async cleanupExpiredStorage(job: DBComputeJob): Promise<boolean> {
    throw new Error(`Not implemented`)
  }
}
