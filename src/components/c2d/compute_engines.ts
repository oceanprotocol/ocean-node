import { Readable } from 'stream'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput,
  OPFK8ComputeStage,
  OPFK8ComputeStageAlgorithm,
  OPFK8ComputeStageInput,
  OPFK8ComputeWorkflow,
  OPFK8ComputeStart,
  OPFK8ComputeStop,
  OPFK8ComputeGetStatus,
  OPFK8ComputeGetResult
} from '../../@types/C2D.js'
import { C2DClusterType } from '../../@types/C2D.js'
import { sign } from '../core/utils/nonceHandler.js'
import axios from 'axios'
import { getConfiguration } from '../../utils/config.js'
import { ZeroAddress } from 'ethers'
import { getProviderFeeToken } from '../../components/core/utils/feesHandler.js'
import { URLUtils } from '../../utils/url.js'

export class C2DEngine {
  private clusterConfig: C2DClusterInfo
  public constructor(cluster: C2DClusterInfo) {
    this.clusterConfig = cluster
  }

  getC2DConfig(): C2DClusterInfo {
    /** Returns cluster config */
    return this.clusterConfig
  }

  getC2DType(): C2DClusterType {
    /** Returns cluster type */
    return this.clusterConfig.type
  }

  static async getC2DByHash(
    clusterHash: string
  ): Promise<C2DEngineOPFK8 | C2DEngineLocal> {
    /**
     * Searches the config by c2d engine hash and returns C2D Class. Throws error if not found
     *
     * @param clusterHash - C2D Engine hash
     *
     */
    const clustersInfo: C2DClusterInfo[] = (await getConfiguration()).c2dClusters
    const cluster = clustersInfo.find(({ hash }) => hash === clusterHash)
    if (cluster) {
      return this.getC2DClass(cluster)
    }
    throw new Error(`C2D Engine not found by hash: ${clusterHash}`)
  }

  static getC2DClass(clusterConfig: C2DClusterInfo): C2DEngineOPFK8 | C2DEngineLocal {
    /**
     * Returns C2D Class, based on config. Throws error if not type not supported
     *
     * @param clusterConfig - cluster config
     *
     */
    switch (clusterConfig.type) {
      case C2DClusterType.OPF_K8:
        return new C2DEngineOPFK8(clusterConfig)
      case C2DClusterType.NODE_LOCAL:
        return new C2DEngineLocal(clusterConfig)
      default:
        throw new Error(`Invalid compute engine type: ${clusterConfig.type}`)
    }
  }

  // functions which need to be implemented by all engine types
  // eslint-disable-next-line require-await
  public async getComputeEnvironments(chainId: number): Promise<ComputeEnvironment[]> {
    throw new Error(`Not implemented`)
  }

  public async envExists(
    chainId: number,
    envIdWithHash?: string,
    envIdWithoutHash?: string
  ) {
    try {
      const envs = await this.getComputeEnvironments(chainId)
      for (const c of envs) {
        if (
          (envIdWithHash && c.id === envIdWithHash) ||
          (envIdWithoutHash && this.clusterConfig.hash + '-' + c.id === envIdWithHash)
        ) {
          return true
        }
      }
    } catch (e) {}
    return false
  }

  public async getComputeEnvironment(
    chainId: number,
    envIdWithHash?: string,
    envIdWithoutHash?: string
  ): Promise<ComputeEnvironment> {
    try {
      const envs = await this.getComputeEnvironments(chainId)
      for (const c of envs) {
        if (
          (envIdWithHash && c.id === envIdWithHash) ||
          (envIdWithoutHash && this.clusterConfig.hash + '-' + c.id === envIdWithHash)
        ) {
          return c
        }
      }
    } catch (e) {}
    return null
  }

  // eslint-disable-next-line require-await
  public async startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    owner: string,
    environment: string,
    validUntil: number,
    chainId: number,
    agreementId: string
  ): Promise<ComputeJob[]> {
    throw new Error(`Not implemented`)
  }

  // eslint-disable-next-line require-await
  public async stopComputeJob(jobId: string, owner: string): Promise<ComputeJob[]> {
    throw new Error(`Not implemented`)
  }

  // eslint-disable-next-line require-await
  public async getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]> {
    throw new Error(`Not implemented`)
  }

  // eslint-disable-next-line require-await
  public async getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number
  ): Promise<Readable> {
    throw new Error(`Not implemented`)
  }
}

export class C2DEngineOPFK8 extends C2DEngine {
  // eslint-disable-next-line no-useless-constructor
  public constructor(clusterConfig: C2DClusterInfo) {
    super(clusterConfig)
  }

  public override async getComputeEnvironments(
    chainId: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */
    const envs: ComputeEnvironment[] = []
    const clusterHash = this.getC2DConfig().hash
    const baseUrl = URLUtils.sanitizeURLPath(this.getC2DConfig().url)
    const url = `${baseUrl}api/v1/operator/environments?chain_id=${chainId}`
    try {
      const { data } = await axios.get(url)
      if (!data) return envs
      // we need to add hash to each env id
      for (const [index, val] of data.entries()) {
        data[index].id = `${clusterHash}-${val.id}`
        if (!data[index].feeToken || data[index].feeToken?.toLowerCase() === ZeroAddress)
          data[index].feeToken = await getProviderFeeToken(chainId)
      }
      return data
    } catch {}
    return envs
  }

  public override async startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    owner: string,
    environment: string,
    validUntil: number,
    chainId: number,
    agreementId: string
  ): Promise<ComputeJob[]> {
    // let's build the stage first
    // start with stage.input
    const config = await getConfiguration()
    const stagesInput: OPFK8ComputeStageInput[] = []
    let index = 0
    for (const asset of assets) {
      if (asset.url)
        stagesInput.push({
          index,
          url: [asset.url]
        })
      else
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
    if (algorithm.url) {
      stageAlgorithm.url = algorithm.url
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
          this.getC2DConfig().url
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
          this.getC2DConfig().url
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
          this.getC2DConfig().url
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
          this.getC2DConfig().url
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
}

export class C2DEngineLocal extends C2DEngine {
  // eslint-disable-next-line no-useless-constructor
  public constructor(clusterConfig: C2DClusterInfo) {
    super(clusterConfig)
  }
  // not implemented yet
}
