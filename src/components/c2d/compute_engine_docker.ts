/* eslint-disable security/detect-non-literal-fs-filename */
import { Readable } from 'stream'
import {
  C2DStatusNumber,
  C2DStatusText,
  DBComputeJobMetadata
} from '../../@types/C2D/C2D.js'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput,
  DBComputeJob,
  DBComputeJobPayment,
  ComputeResult,
  RunningPlatform,
  ComputeEnvFeesStructure,
  ComputeResourceRequest,
  ComputeEnvFees
} from '../../@types/C2D/C2D.js'
import { getConfiguration } from '../../utils/config.js'
import { C2DEngine } from './compute_engine_base.js'
import { C2DDatabase } from '../database/C2DDatabase.js'
import { Escrow } from '../core/utils/escrow.js'
import { create256Hash } from '../../utils/crypt.js'
import { Storage } from '../storage/index.js'
import Dockerode from 'dockerode'
import type { ContainerCreateOptions, HostConfig, VolumeCreateOptions } from 'dockerode'
import * as tar from 'tar'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  statSync,
  createReadStream
} from 'fs'
import { pipeline } from 'node:stream/promises'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { AssetUtils } from '../../utils/asset.js'
import { FindDdoHandler } from '../core/handler/ddoHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { decryptFilesObject, omitDBComputeFieldsFromComputeJob } from './index.js'
import * as drc from 'docker-registry-client'
import { ValidateParams } from '../httpRoutes/validateCommands.js'
import { Service } from '@oceanprotocol/ddo-js'
import { getOceanTokenAddressForChain } from '../../utils/address.js'

export class C2DEngineDocker extends C2DEngine {
  private envs: ComputeEnvironment[] = []

  public docker: Dockerode
  private cronTimer: any
  private cronTime: number = 2000
  public constructor(clusterConfig: C2DClusterInfo, db: C2DDatabase, escrow: Escrow) {
    super(clusterConfig, db, escrow)

    this.docker = null
    if (clusterConfig.connection.socketPath) {
      try {
        this.docker = new Dockerode({ socketPath: clusterConfig.connection.socketPath })
      } catch (e) {
        CORE_LOGGER.error('Could not create Docker container: ' + e.message)
      }
    }
    if (
      clusterConfig.connection.protocol &&
      clusterConfig.connection.host &&
      clusterConfig.connection.port
    ) {
      try {
        this.docker = new Dockerode({
          protocol: clusterConfig.connection.protocol,
          host: clusterConfig.connection.host,
          port: clusterConfig.connection.port
        })
      } catch (e) {
        CORE_LOGGER.error('Could not create Docker container: ' + e.message)
      }
    }
    // TO DO C2D - create envs
    try {
      if (!existsSync(clusterConfig.tempFolder))
        mkdirSync(clusterConfig.tempFolder, { recursive: true })
    } catch (e) {
      CORE_LOGGER.error(
        'Could not create Docker container temporary folders: ' + e.message
      )
    }
    // envs are build on start function
  }

  public override async start() {
    // let's build the env.   Swarm and k8 will build multiple envs, based on arhitecture
    const config = await getConfiguration()
    const envConfig = await this.getC2DConfig().connection
    let sysinfo = null
    try {
      sysinfo = await this.docker.info()
    } catch (e) {
      CORE_LOGGER.error('Could not get docker info: ' + e.message)
      // since we cannot connect to docker, we cannot start the engine -> no envs
      return
    }
    // console.log(sysinfo)
    let fees: ComputeEnvFeesStructure = null

    const supportedChains: number[] = []
    for (const chain of Object.keys(config.supportedNetworks)) {
      supportedChains.push(parseInt(chain))
    }
    for (const feeChain of Object.keys(envConfig.fees)) {
      // for (const feeConfig of envConfig.fees) {
      // console.log(feeChain)
      if (supportedChains.includes(parseInt(feeChain))) {
        if (fees === null) fees = {}
        if (!(feeChain in fees)) fees[feeChain] = []
        const tmpFees: ComputeEnvFees[] = []
        for (let i = 0; i < envConfig.fees[feeChain].length; i++) {
          if (
            envConfig.fees[feeChain][i].prices &&
            envConfig.fees[feeChain][i].prices.length > 0
          ) {
            if (!envConfig.fees[feeChain][i].feeToken) {
              const tokenAddress = await getOceanTokenAddressForChain(parseInt(feeChain))
              if (tokenAddress) {
                envConfig.fees[feeChain][i].feeToken = tokenAddress
                tmpFees.push(envConfig.fees[feeChain][i])
              } else {
                CORE_LOGGER.error(
                  `Unable to find Ocean token address for chain ${feeChain} and no custom token provided`
                )
              }
            } else {
              tmpFees.push(envConfig.fees[feeChain][i])
            }
          } else {
            CORE_LOGGER.error(
              `Unable to find prices for fee ${JSON.stringify(
                envConfig.fees[feeChain][i]
              )} on chain ${feeChain}`
            )
          }
        }
        fees[feeChain] = tmpFees
      }

      /* for (const chain of Object.keys(config.supportedNetworks)) {
        const chainId = parseInt(chain)
        if (task.chainId && task.chainId !== chainId) continue
        result[chainId] = await computeEngines.fetchEnvironments(chainId)
      } */
    }
    this.envs.push({
      id: '', // this.getC2DConfig().hash + '-' + create256Hash(JSON.stringify(this.envs[i])),
      runningJobs: 0,
      consumerAddress: config.keys.ethAddress,
      platform: {
        architecture: sysinfo.Architecture,
        os: sysinfo.OperatingSystem
      },
      fees
    })
    if (`storageExpiry` in envConfig) this.envs[0].storageExpiry = envConfig.storageExpiry
    if (`maxJobDuration` in envConfig)
      this.envs[0].maxJobDuration = envConfig.maxJobDuration
    if (`maxJobs` in envConfig) this.envs[0].maxJobs = envConfig.maxJobs
    // let's add resources
    this.envs[0].resources = []
    this.envs[0].resources.push({
      id: 'cpu',
      type: 'cpu',
      total: sysinfo.NCPU,
      max: sysinfo.NCPU,
      min: 1
    })
    this.envs[0].resources.push({
      id: 'ram',
      type: 'ram',
      total: sysinfo.MemTotal,
      max: sysinfo.MemTotal,
      min: 1e9
    })

    if (envConfig.resources) {
      for (const res of envConfig.resources) {
        // allow user to add other resources
        if (res.id !== 'cpu' && res.id !== 'ram') {
          if (!res.max) res.max = res.total
          if (!res.min) res.min = 0
          this.envs[0].resources.push(res)
        }
      }
    }
    /* TODO  - get namedresources & discreete one 
    if (sysinfo.GenericResources) {
      for (const [key, value] of Object.entries(sysinfo.GenericResources)) {
        for (const [type, val] of Object.entries(value)) {
          // for (const resType in sysinfo.GenericResources) {
          if (type === 'NamedResourceSpec') {
            // if we have it, ignore it
            const resourceId = val.Value
            const resourceType = val.Kind
            let found = false
            for (const res of this.envs[0].resources) {
              if (res.id === resourceId) {
                found = true
                break
              }
            }
            if (!found) {
              this.envs[0].resources.push({
                id: resourceId,
                kind: resourceType,
                total: 1,
                max: 1,
                min: 0
              })
            }
          }
        }
      }
    }
      */
    // limits for free env
    if ('free' in envConfig) {
      this.envs[0].free = {}
      if (`storageExpiry` in envConfig.free)
        this.envs[0].free.storageExpiry = envConfig.free.storageExpiry
      if (`maxJobDuration` in envConfig.free)
        this.envs[0].free.maxJobDuration = envConfig.free.maxJobDuration
      if (`maxJobs` in envConfig.free) this.envs[0].free.maxJobs = envConfig.free.maxJobs
      if ('resources' in envConfig.free) {
        // TO DO - check if resource is also listed in this.envs[0].resources, if not, ignore it
        this.envs[0].free.resources = envConfig.free.resources
      }
    }
    this.envs[0].id =
      this.getC2DConfig().hash + '-' + create256Hash(JSON.stringify(this.envs[0]))

    // only now set the timer
    if (!this.cronTimer) {
      this.setNewTimer()
    }
  }

  // eslint-disable-next-line require-await
  public override async getComputeEnvironments(
    chainId?: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments, filtered by a specific chainId if needed. Env's id already contains the cluster hash
     */
    if (!this.docker) return []
    const filteredEnvs = []
    // const systemInfo = this.docker ? await this.docker.info() : null
    for (const computeEnv of this.envs) {
      if (
        !chainId ||
        (computeEnv.fees && Object.hasOwn(computeEnv.fees, String(chainId)))
      ) {
        // TO DO - At some point in time we need to handle multiple runtimes
        // console.log('********************************')
        // console.log(systemInfo.GenericResources)
        // console.log('********************************')
        // if (systemInfo.Runtimes) computeEnv.runtimes = systemInfo.Runtimes
        // if (systemInfo.DefaultRuntime)
        // computeEnv.defaultRuntime = systemInfo.DefaultRuntime
        const { totalJobs, totalFreeJobs, usedResources, usedFreeResources } =
          await this.getUsedResources(computeEnv)
        computeEnv.runningJobs = totalJobs
        computeEnv.runningfreeJobs = totalFreeJobs
        for (let i = 0; i < computeEnv.resources.length; i++) {
          if (computeEnv.resources[i].id in usedResources)
            computeEnv.resources[i].inUse = usedResources[computeEnv.resources[i].id]
          else computeEnv.resources[i].inUse = 0
        }
        if (computeEnv.free && computeEnv.free.resources) {
          for (let i = 0; i < computeEnv.free.resources.length; i++) {
            if (computeEnv.free.resources[i].id in usedFreeResources)
              computeEnv.free.resources[i].inUse =
                usedFreeResources[computeEnv.free.resources[i].id]
            else computeEnv.free.resources[i].inUse = 0
          }
        }
        filteredEnvs.push(computeEnv)
      }
    }

    return filteredEnvs
  }

  /**
   * Checks the docker image by looking at the manifest
   * @param image name or tag
   * @returns boolean
   */
  public static async checkDockerImage(
    image: string,
    platform?: RunningPlatform
  ): Promise<ValidateParams> {
    try {
      const info = drc.default.parseRepoAndRef(image)
      /**
     * info:  {
        index: { name: 'docker.io', official: true },
        official: true,
        remoteName: 'library/node',
        localName: 'node',
        canonicalName: 'docker.io/node',
        digest: 'sha256:1155995dda741e93afe4b1c6ced2d01734a6ec69865cc0997daf1f4db7259a36'
      }
     */
      const client = drc.createClientV2({ name: info.localName })
      const tagOrDigest = info.tag || info.digest

      // try get manifest from registry
      return await new Promise<any>((resolve, reject) => {
        client.getManifest(
          { ref: tagOrDigest, maxSchemaVersion: 2 },
          function (err: any, manifest: any) {
            client.close()
            if (manifest) {
              return resolve({
                valid: checkManifestPlatform(manifest.platform, platform)
              })
            }

            if (err) {
              CORE_LOGGER.error(
                `Unable to get Manifest for image ${image}: ${err.message}`
              )
              reject(err)
            }
          }
        )
      })
    } catch (err) {
      // show all aggregated errors, if present
      const aggregated = err.errors && err.errors.length > 0
      aggregated ? CORE_LOGGER.error(JSON.stringify(err.errors)) : CORE_LOGGER.error(err)
      return {
        valid: false,
        status: 404,
        reason: aggregated ? JSON.stringify(err.errors) : err.message
      }
    }
  }

  // eslint-disable-next-line require-await
  public override async startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    environment: string,
    owner: string,
    maxJobDuration: number,
    resources: ComputeResourceRequest[],
    payment: DBComputeJobPayment,
    jobId: string,
    metadata?: DBComputeJobMetadata
  ): Promise<ComputeJob[]> {
    if (!this.docker) return []
    // TO DO - iterate over resources and get default runtime
    const isFree: boolean = !(payment && payment.lockTx)

    // C2D - Check image, check arhitecture, etc
    const image = getAlgorithmImage(algorithm)
    // ex: node@sha256:1155995dda741e93afe4b1c6ced2d01734a6ec69865cc0997daf1f4db7259a36
    if (!image) {
      // send a 500 with the error message
      throw new Error(
        `Unable to extract docker image ${image} from algoritm: ${JSON.stringify(
          algorithm
        )}`
      )
    }

    if (metadata && Object.keys(metadata).length > 0) {
      const metadataSize = JSON.stringify(metadata).length
      if (metadataSize > 1024) {
        throw new Error('Metadata size is too large')
      }
    }

    const envIdWithHash = environment && environment.indexOf('-') > -1
    const env = await this.getComputeEnvironment(
      payment && payment.chainId ? payment.chainId : null,
      envIdWithHash ? environment : null,
      environment
    )
    if (!env) {
      throw new Error(`Invalid environment ${environment}`)
    }
    const validation = await C2DEngineDocker.checkDockerImage(image, env.platform)
    if (!validation.valid)
      throw new Error(`Unable to validate docker image ${image}: ${validation.reason}`)
    const job: DBComputeJob = {
      clusterHash: this.getC2DConfig().hash,
      containerImage: image,
      owner,
      jobId,
      dateCreated: String(Date.now() / 1000),
      dateFinished: null,
      status: C2DStatusNumber.JobStarted,
      statusText: C2DStatusText.JobStarted,
      results: [],
      algorithm,
      assets,
      maxJobDuration,
      environment,
      configlogURL: null,
      publishlogURL: null,
      algologURL: null,
      outputsURL: null,
      stopRequested: false,
      isRunning: true,
      isStarted: false,
      resources,
      isFree,
      algoStartTimestamp: '0',
      algoStopTimestamp: '0',
      payment,
      metadata
    }
    await this.makeJobFolders(job)
    // make sure we actually were able to insert on DB
    const addedId = await this.db.newJob(job)
    if (!addedId) {
      return []
    }

    // only now set the timer
    if (!this.cronTimer) {
      this.setNewTimer()
    }
    const cjob: ComputeJob = omitDBComputeFieldsFromComputeJob(job)
    // we add cluster hash to user output
    cjob.jobId = this.getC2DConfig().hash + '-' + cjob.jobId
    // cjob.jobId = jobId
    return [cjob]
  }

  // eslint-disable-next-line require-await
  public override async stopComputeJob(
    jobId: string,
    owner: string,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    const jobs = await this.db.getJob(jobId, agreementId, owner)
    if (jobs.length === 0) {
      return []
    }
    const statusResults = []
    for (const job of jobs) {
      job.stopRequested = true
      await this.db.updateJob(job)
      const res: ComputeJob = omitDBComputeFieldsFromComputeJob(job)
      statusResults.push(res)
    }

    return statusResults
  }

  // eslint-disable-next-line require-await
  protected async getResults(jobId: string): Promise<ComputeResult[]> {
    const res: ComputeResult[] = []
    let index = 0
    try {
      const logStat = statSync(
        this.getC2DConfig().tempFolder + '/' + jobId + '/data/logs/algorithm.log'
      )
      if (logStat) {
        res.push({
          filename: 'algorithm.log',
          filesize: logStat.size,
          type: 'algorithmLog',
          index
        })
        index = index + 1
      }
    } catch (e) {}
    try {
      const outputStat = statSync(
        this.getC2DConfig().tempFolder + '/' + jobId + '/data/outputs/outputs.tar'
      )
      if (outputStat) {
        res.push({
          filename: 'outputs.tar',
          filesize: outputStat.size,
          type: 'output',
          index
        })
        index = index + 1
      }
    } catch (e) {}
    return res
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]> {
    const jobs = await this.db.getJob(jobId, agreementId, consumerAddress)
    if (jobs.length === 0) {
      return []
    }
    const statusResults = []
    for (const job of jobs) {
      const res: ComputeJob = omitDBComputeFieldsFromComputeJob(job)
      // add results for algoLogs
      res.results = await this.getResults(job.jobId)
      statusResults.push(res)
    }

    return statusResults
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number
  ): Promise<{ stream: Readable; headers: any }> {
    const jobs = await this.db.getJob(jobId, null, consumerAddress)
    if (jobs.length === 0) {
      return null
    }
    const results = await this.getResults(jobId)
    for (const i of results) {
      if (i.index === index) {
        if (i.type === 'algorithmLog') {
          return {
            stream: createReadStream(
              this.getC2DConfig().tempFolder + '/' + jobId + '/data/logs/algorithm.log'
            ),
            headers: {
              'Content-Type': 'text/plain'
            }
          }
        }
        if (i.type === 'output') {
          return {
            stream: createReadStream(
              this.getC2DConfig().tempFolder + '/' + jobId + '/data/outputs/outputs.tar'
            ),
            headers: {
              'Content-Type': 'application/octet-stream'
            }
          }
        }
      }
    }
    return null
  }

  // eslint-disable-next-line require-await
  public override async getStreamableLogs(jobId: string): Promise<NodeJS.ReadableStream> {
    const jobRes: DBComputeJob[] = await this.db.getJob(jobId)
    if (jobRes.length === 0) return null
    if (!jobRes[0].isRunning) return null
    try {
      const job = jobRes[0]
      const container = await this.docker.getContainer(job.jobId + '-algoritm')
      const details = await container.inspect()
      if (details.State.Running === false) return null
      return await container.logs({
        stdout: true,
        stderr: true,
        follow: true
      })
    } catch (e) {
      return null
    }
  }

  private async setNewTimer() {
    // don't set the cron if we don't have compute environments
    if ((await this.getComputeEnvironments()).length > 0)
      this.cronTimer = setInterval(this.InternalLoop.bind(this), this.cronTime)
  }

  private async InternalLoop() {
    // this is the internal loop of docker engine
    // gets list of all running jobs and process them one by one
    clearInterval(this.cronTimer)
    this.cronTimer = null
    // get all running jobs
    const jobs = await this.db.getRunningJobs(this.getC2DConfig().hash)

    if (jobs.length === 0) {
      CORE_LOGGER.info('No C2D jobs found for engine ' + this.getC2DConfig().hash)
      this.setNewTimer()
      return
    } else {
      CORE_LOGGER.info(`Got ${jobs.length} jobs for engine ${this.getC2DConfig().hash}`)
      CORE_LOGGER.debug(JSON.stringify(jobs))
    }
    const promises: any = []
    for (const job of jobs) {
      promises.push(this.processJob(job))
    }
    // wait for all promises, there is no return
    await Promise.all(promises)
    // set the cron again
    this.setNewTimer()
  }

  private async createDockerContainer(
    containerInfo: ContainerCreateOptions,
    retry: boolean = false
  ): Promise<Dockerode.Container> | null {
    try {
      const container = await this.docker.createContainer(containerInfo)
      console.log('container: ', container)
      return container
    } catch (e) {
      CORE_LOGGER.error(`Unable to create docker container: ${e.message}`)
      if (
        e.message
          .toLowerCase()
          .includes('--storage-opt is supported only for overlay over xfs') &&
        retry
      ) {
        delete containerInfo.HostConfig.StorageOpt
        CORE_LOGGER.info('Retrying again without HostConfig.StorageOpt options...')
        // Retry without that option because it does not work
        return this.createDockerContainer(containerInfo)
      }
      return null
    }
  }

  private async createDockerVolume(
    volume: VolumeCreateOptions,
    retry: boolean = false
  ): Promise<boolean> {
    try {
      await this.docker.createVolume(volume)
      return true
    } catch (e) {
      CORE_LOGGER.error(`Unable to create docker volume: ${e.message}`)
      if (
        e.message.toLowerCase().includes('quota size requested but no quota support') &&
        retry
      ) {
        delete volume.DriverOpts
        CORE_LOGGER.info('Retrying again without DriverOpts options...')
        try {
          return this.createDockerVolume(volume)
        } catch (e) {
          CORE_LOGGER.error(
            `Unable to create docker volume without DriverOpts: ${e.message}`
          )
          return false
        }
      }
      return false
    }
  }

  // eslint-disable-next-line require-await
  private async processJob(job: DBComputeJob) {
    console.log(`Process job started: [STATUS: ${job.status}: ${job.statusText}]`)
    console.log(job)
    // has to :
    //  - monitor running containers and stop them if over limits
    //  - monitor disc space and clean up
    /* steps:
       - instruct docker to pull image
       - create volume
       - after image is ready, create the container
       - download assets & algo into temp folder
       - download DDOS
       - tar and upload assets & algo to container
       - start the container
       - check if container is exceeding validUntil
       - if yes, stop it
       - download /data/outputs and store it locally (or upload it somewhere)
       - delete the container
       - delete the volume
       */
    if (job.status === C2DStatusNumber.JobStarted) {
      // pull docker image
      try {
        const pullStream = await this.docker.pull(job.containerImage)
        await new Promise((resolve, reject) => {
          let wroteStatusBanner = false
          this.docker.modem.followProgress(
            pullStream,
            (err: any, res: any) => {
              // onFinished
              if (err) return reject(err)
              CORE_LOGGER.info('############# Pull docker image complete ##############')
              resolve(res)
            },
            (progress: any) => {
              // onProgress
              if (!wroteStatusBanner) {
                wroteStatusBanner = true
                CORE_LOGGER.info('############# Pull docker image status: ##############')
              }
              // only write the status banner once, its cleaner
              CORE_LOGGER.info(progress.status)
            }
          )
        })
      } catch (err) {
        CORE_LOGGER.error(
          `Unable to pull docker image: ${job.containerImage}: ${err.message}`
        )
        job.status = C2DStatusNumber.PullImageFailed
        job.statusText = C2DStatusText.PullImageFailed
        job.isRunning = false
        job.dateFinished = String(Date.now() / 1000)
        await this.db.updateJob(job)
        await this.cleanupJob(job)
        return
      }

      job.status = C2DStatusNumber.PullImage
      job.statusText = C2DStatusText.PullImage
      await this.db.updateJob(job)
      return // now we wait until image is ready
    }
    if (job.status === C2DStatusNumber.PullImage) {
      try {
        const imageInfo = await this.docker.getImage(job.containerImage)
        console.log('imageInfo', imageInfo)
        const details = await imageInfo.inspect()
        console.log('details:', details)
        job.status = C2DStatusNumber.ConfiguringVolumes
        job.statusText = C2DStatusText.ConfiguringVolumes
        await this.db.updateJob(job)
        // now we can move forward
      } catch (e) {
        // not ready yet
        CORE_LOGGER.error(`Unable to inspect docker image: ${e.message}`)
      }
      return
    }
    if (job.status === C2DStatusNumber.ConfiguringVolumes) {
      // create the volume & create container
      // TO DO C2D:  Choose driver & size
      // get env info
      const envResource = this.envs[0].resources
      const volume: VolumeCreateOptions = {
        Name: job.jobId + '-volume'
      }
      // volume
      /* const diskSize = this.getResourceRequest(job.resources, 'disk')
       if (diskSize && diskSize > 0) {
        volume.DriverOpts = {
          o: 'size=' + String(diskSize),
          device: 'local',
          type: 'local'
        }
      } */
      const volumeCreated = await this.createDockerVolume(volume, true)
      if (!volumeCreated) {
        job.status = C2DStatusNumber.VolumeCreationFailed
        job.statusText = C2DStatusText.VolumeCreationFailed
        job.isRunning = false
        job.dateFinished = String(Date.now() / 1000)
        await this.db.updateJob(job)
        await this.cleanupJob(job)
        return
      }

      // create the container
      const mountVols: any = { '/data': {} }
      const hostConfig: HostConfig = {
        Mounts: [
          {
            Type: 'volume',
            Source: volume.Name,
            Target: '/data',
            ReadOnly: false
          }
        ]
      }
      // disk
      // if (diskSize && diskSize > 0) {
      //  hostConfig.StorageOpt = {
      //  size: String(diskSize)
      // }
      // }
      // ram
      const ramSize = this.getResourceRequest(job.resources, 'ram')
      if (ramSize && ramSize > 0) {
        hostConfig.Memory = ramSize
        // set swap to same memory value means no swap (otherwise it use like 2X mem)
        hostConfig.MemorySwap = hostConfig.Memory
      }
      const cpus = this.getResourceRequest(job.resources, 'cpu')
      if (cpus && cpus > 0) {
        const systemInfo = this.docker ? await this.docker.info() : null
        hostConfig.CpuPeriod = 100000 // 100 miliseconds is usually the default
        hostConfig.CpuQuota = Math.floor((cpus / systemInfo.NCPU) * hostConfig.CpuPeriod)
      }
      const containerInfo: ContainerCreateOptions = {
        name: job.jobId + '-algoritm',
        Image: job.containerImage,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        OpenStdin: false,
        StdinOnce: false,
        Volumes: mountVols,
        HostConfig: hostConfig
      }
      // TO DO - iterate over resources and get default runtime
      // TO DO - check resources and pass devices
      const dockerDeviceRequest = this.getDockerDeviceRequest(job.resources, envResource)
      if (dockerDeviceRequest) {
        containerInfo.HostConfig.DeviceRequests = dockerDeviceRequest
      }
      const advancedConfig = this.getDockerAdvancedConfig(job.resources, envResource)
      if (advancedConfig.Devices)
        containerInfo.HostConfig.Devices = advancedConfig.Devices
      if (advancedConfig.GroupAdd)
        containerInfo.HostConfig.GroupAdd = advancedConfig.GroupAdd
      if (advancedConfig.SecurityOpt)
        containerInfo.HostConfig.SecurityOpt = advancedConfig.SecurityOpt
      if (advancedConfig.Binds) containerInfo.HostConfig.Binds = advancedConfig.Binds
      if (advancedConfig.CapAdd) containerInfo.HostConfig.CapAdd = advancedConfig.CapAdd
      if (advancedConfig.CapDrop)
        containerInfo.HostConfig.CapDrop = advancedConfig.CapDrop
      if (advancedConfig.IpcMode)
        containerInfo.HostConfig.IpcMode = advancedConfig.IpcMode
      if (advancedConfig.ShmSize)
        containerInfo.HostConfig.ShmSize = advancedConfig.ShmSize
      if (job.algorithm.meta.container.entrypoint) {
        const newEntrypoint = job.algorithm.meta.container.entrypoint.replace(
          '$ALGO',
          'data/transformations/algorithm'
        )
        containerInfo.Entrypoint = newEntrypoint.split(' ')
      }
      const container = await this.createDockerContainer(containerInfo, true)
      if (container) {
        console.log('Container created: ', container)
        job.status = C2DStatusNumber.Provisioning
        job.statusText = C2DStatusText.Provisioning
        await this.db.updateJob(job)
      } else {
        job.status = C2DStatusNumber.ContainerCreationFailed
        job.statusText = C2DStatusText.ContainerCreationFailed
        job.isRunning = false
        job.dateFinished = String(Date.now() / 1000)
        await this.db.updateJob(job)
        await this.cleanupJob(job)
        return
      }
      return
    }
    if (job.status === C2DStatusNumber.Provisioning) {
      // download algo & assets
      const ret = await this.uploadData(job)
      console.log('Upload data')
      console.log(ret)
      job.status = ret.status
      job.statusText = ret.statusText
      if (job.status !== C2DStatusNumber.RunningAlgorithm) {
        // failed, let's close it
        job.isRunning = false
        job.dateFinished = String(Date.now() / 1000)
        await this.db.updateJob(job)
        await this.cleanupJob(job)
      } else {
        await this.db.updateJob(job)
      }
    }
    if (job.status === C2DStatusNumber.RunningAlgorithm) {
      const container = await this.docker.getContainer(job.jobId + '-algoritm')
      const details = await container.inspect()
      console.log('Container inspect')
      console.log(details)
      if (job.isStarted === false) {
        // make sure is not started
        if (details.State.Running === false) {
          try {
            await container.start()
            job.isStarted = true
            job.algoStartTimestamp = String(Date.now() / 1000)
            await this.db.updateJob(job)
            return
          } catch (e) {
            // container failed to start
            job.algoStartTimestamp = String(Date.now() / 1000)
            job.algoStopTimestamp = String(Date.now() / 1000)
            try {
              const algoLogFile =
                this.getC2DConfig().tempFolder +
                '/' +
                job.jobId +
                '/data/logs/algorithm.log'
              writeFileSync(algoLogFile, String(e.message))
            } catch (e) {
              console.log('Failed to write')
              console.log(e)
            }
            console.error('could not start container: ' + e.message)
            console.log(e)
            job.status = C2DStatusNumber.AlgorithmFailed
            job.statusText = C2DStatusText.AlgorithmFailed

            job.isRunning = false
            job.dateFinished = String(Date.now() / 1000)
            await this.db.updateJob(job)
            await this.cleanupJob(job)
            return
          }
        }
      } else {
        // is running, we need to stop it..
        console.log('running, need to stop it?')
        const timeNow = Date.now() / 1000
        const expiry = parseFloat(job.algoStartTimestamp) + job.maxJobDuration
        console.log('timeNow: ' + timeNow + ' , Expiry: ' + expiry)
        if (timeNow > expiry || job.stopRequested) {
          // we need to stop the container
          // make sure is running
          console.log('We need to stop')
          console.log(details.State.Running)
          if (details.State.Running === true) {
            try {
              await container.stop()
            } catch (e) {
              // we should never reach this, unless the container is already stopped or deleted by someone else
              console.log(e)
            }
          }
          console.log('Stopped')
          job.isStarted = false
          job.status = C2DStatusNumber.PublishingResults
          job.statusText = C2DStatusText.PublishingResults
          job.algoStopTimestamp = String(Date.now() / 1000)
          job.isRunning = false
          await this.db.updateJob(job)
          return
        } else {
          if (details.State.Running === false) {
            job.isStarted = false
            job.status = C2DStatusNumber.PublishingResults
            job.statusText = C2DStatusText.PublishingResults
            job.algoStopTimestamp = String(Date.now() / 1000)
            job.isRunning = false
            await this.db.updateJob(job)
            return
          }
        }
      }
    }
    if (job.status === C2DStatusNumber.PublishingResults) {
      // get output
      job.status = C2DStatusNumber.JobFinished
      job.statusText = C2DStatusText.JobFinished
      const container = await this.docker.getContainer(job.jobId + '-algoritm')
      const outputsArchivePath =
        this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/outputs/outputs.tar'
      try {
        await pipeline(
          await container.getArchive({ path: '/data/outputs' }),
          createWriteStream(outputsArchivePath)
        )
      } catch (e) {
        console.log(e)
        job.status = C2DStatusNumber.ResultsUploadFailed
        job.statusText = C2DStatusText.ResultsUploadFailed
      }
      job.isRunning = false
      job.dateFinished = String(Date.now() / 1000)
      await this.db.updateJob(job)
      await this.cleanupJob(job)
    }
  }

  // eslint-disable-next-line require-await
  private async cleanupJob(job: DBComputeJob) {
    // cleaning up
    // - claim payment or release lock
    //  - get algo logs
    //  - delete volume
    //  - delete container

    // payments
    if (!job.isFree && job.payment) {
      let txId = null
      const env = await this.getComputeEnvironment(job.payment.chainId, job.environment)
      let minDuration = 0
      if (env && `minJobDuration` in env && env.minJobDuration) {
        minDuration = env.minJobDuration
      }
      const algoRunnedTime =
        parseFloat(job.algoStopTimestamp) - parseFloat(job.algoStartTimestamp)
      if (algoRunnedTime < 0) minDuration += algoRunnedTime * -1
      else minDuration += algoRunnedTime
      if (minDuration > 0) {
        // we need to claim
        const cost = this.getTotalCostOfJob(job.resources, minDuration)
        const proof = JSON.stringify(omitDBComputeFieldsFromComputeJob(job))
        try {
          txId = await this.escrow.claimLock(
            job.payment.chainId,
            job.jobId,
            job.payment.token,
            job.owner,
            cost,
            proof
          )
        } catch (e) {
          console.log(e)
        }
      } else {
        // release the lock, we are not getting paid
        try {
          txId = await this.escrow.cancelExpiredLocks(
            job.payment.chainId,
            job.jobId,
            job.payment.token,
            job.owner
          )
        } catch (e) {
          console.log(e)
        }
      }
      if (txId) {
        job.payment.claimTx = txId
        await this.db.updateJob(job)
      }
    }
    try {
      const container = await this.docker.getContainer(job.jobId + '-algoritm')
      if (container) {
        if (job.status !== C2DStatusNumber.AlgorithmFailed) {
          writeFileSync(
            this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/logs/algorithm.log',
            await container.logs({
              stdout: true,
              stderr: true,
              follow: false
            })
          )
        }
        await container.remove()
      }
      const volume = await this.docker.getVolume(job.jobId + '-volume')
      if (volume) {
        try {
          await volume.remove()
        } catch (e) {
          console.log(e)
        }
      }
      // remove folders
      rmSync(this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/inputs', {
        recursive: true,
        force: true
      })
      rmSync(this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/transformations', {
        recursive: true,
        force: true
      })
    } catch (e) {
      console.log(e)
    }
  }

  private deleteOutputFolder(job: DBComputeJob) {
    rmSync(this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/outputs/', {
      recursive: true,
      force: true
    })
  }

  private async uploadData(
    job: DBComputeJob
  ): Promise<{ status: C2DStatusNumber; statusText: C2DStatusText }> {
    const config = await getConfiguration()
    const ret = {
      status: C2DStatusNumber.RunningAlgorithm,
      statusText: C2DStatusText.RunningAlgorithm
    }
    // for testing purposes
    // if (!job.algorithm.fileObject) {
    //   console.log('no file object')
    //   const file: UrlFileObject = {
    //     type: 'url',
    //     url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
    //     method: 'get'
    //   }
    //   job.algorithm.fileObject = file
    // }
    // download algo
    // TODO: we currently DO NOT have a way to set this field unencrypted (once we publish the asset its encrypted)
    // So we cannot test this from the CLI for instance... Only Option is to actually send it encrypted
    // OR extract the files object from the passed DDO, decrypt it and use it

    // console.log(job.algorithm.fileObject)
    const fullAlgoPath =
      this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/transformations/algorithm'
    try {
      const customdataPath =
        this.getC2DConfig().tempFolder +
        '/' +
        job.jobId +
        '/data/inputs/algoCustomData.json'
      writeFileSync(customdataPath, JSON.stringify(job.algorithm.algocustomdata ?? {}))

      let storage = null

      if (job.algorithm.meta.rawcode && job.algorithm.meta.rawcode.length > 0) {
        // we have the code, just write it
        writeFileSync(fullAlgoPath, job.algorithm.meta.rawcode)
      } else {
        // do we have a files object?
        if (job.algorithm.fileObject) {
          // is it unencrypted?
          if (job.algorithm.fileObject.type) {
            // we can get the storage directly
            storage = Storage.getStorageClass(job.algorithm.fileObject, config)
          } else {
            // ok, maybe we have this encrypted instead
            CORE_LOGGER.info(
              'algorithm file object seems to be encrypted, checking it...'
            )
            // 1. Decrypt the files object
            const decryptedFileObject = await decryptFilesObject(job.algorithm.fileObject)
            console.log('decryptedFileObject: ', decryptedFileObject)
            // 2. Get default storage settings
            storage = Storage.getStorageClass(decryptedFileObject, config)
          }
        } else {
          // no files object, try to get information from documentId and serviceId
          CORE_LOGGER.info(
            'algorithm file object seems to be missing, checking "serviceId" and "documentId"...'
          )
          const { serviceId, documentId } = job.algorithm
          // we can get it from this info
          if (serviceId && documentId) {
            const algoDdo = await new FindDdoHandler(
              OceanNode.getInstance()
            ).findAndFormatDdo(documentId)
            console.log('algo ddo:', algoDdo)
            // 1. Get the service
            const service: Service = AssetUtils.getServiceById(algoDdo, serviceId)

            // 2. Decrypt the files object
            const decryptedFileObject = await decryptFilesObject(service.files)
            console.log('decryptedFileObject: ', decryptedFileObject)
            // 4. Get default storage settings
            storage = Storage.getStorageClass(decryptedFileObject, config)
          }
        }

        if (storage) {
          console.log('fullAlgoPath', fullAlgoPath)
          await pipeline(
            (await storage.getReadableStream()).stream,
            createWriteStream(fullAlgoPath)
          )
        } else {
          CORE_LOGGER.info(
            'Could not extract any files object from the compute algorithm, skipping...'
          )
        }
      }
    } catch (e) {
      CORE_LOGGER.error(
        'Unable to write algorithm to path: ' + fullAlgoPath + ': ' + e.message
      )
      return {
        status: C2DStatusNumber.AlgorithmProvisioningFailed,
        statusText: C2DStatusText.AlgorithmProvisioningFailed
      }
    }

    // now for the assets
    for (const i in job.assets) {
      const asset = job.assets[i]
      let storage = null
      let fileInfo = null
      console.log('checking now asset: ', asset)
      // without this check it would break if no fileObject is present
      if (asset.fileObject) {
        if (asset.fileObject.type) {
          storage = Storage.getStorageClass(asset.fileObject, config)
        } else {
          CORE_LOGGER.info('asset file object seems to be encrypted, checking it...')
          // get the encrypted bytes
          const filesObject: any = await decryptFilesObject(asset.fileObject)
          storage = Storage.getStorageClass(filesObject, config)
        }

        // we need the file info for the name (but could be something else here)
        fileInfo = await storage.getFileInfo({
          type: storage.getStorageType(asset.fileObject)
        })
      } else {
        // we need to go the hard way
        const { serviceId, documentId } = asset
        if (serviceId && documentId) {
          // need to get the file
          const ddo = await new FindDdoHandler(OceanNode.getInstance()).findAndFormatDdo(
            documentId
          )

          // 2. Get the service
          const service: Service = AssetUtils.getServiceById(ddo, serviceId)
          // 3. Decrypt the url
          const decryptedFileObject = await decryptFilesObject(service.files)
          console.log('decryptedFileObject: ', decryptedFileObject)
          storage = Storage.getStorageClass(decryptedFileObject, config)

          fileInfo = await storage.getFileInfo({
            type: storage.getStorageType(decryptedFileObject)
          })
        }
      }

      if (storage && fileInfo) {
        const fullPath =
          this.getC2DConfig().tempFolder +
          '/' +
          job.jobId +
          '/data/inputs/' +
          fileInfo[0].name

        console.log('asset full path: ' + fullPath)
        try {
          await pipeline(
            (await storage.getReadableStream()).stream,
            createWriteStream(fullPath)
          )
        } catch (e) {
          CORE_LOGGER.error(
            'Unable to write input data to path: ' + fullPath + ': ' + e.message
          )
          return {
            status: C2DStatusNumber.DataProvisioningFailed,
            statusText: C2DStatusText.DataProvisioningFailed
          }
        }
      } else {
        CORE_LOGGER.info(
          'Could not extract any files object from the compute asset, skipping...'
        )
      }
    }
    CORE_LOGGER.info('All good with data provisioning, will start uploading it...')
    // now, we have to create a tar arhive
    const folderToTar = this.getC2DConfig().tempFolder + '/' + job.jobId + '/data'
    const destination =
      this.getC2DConfig().tempFolder + '/' + job.jobId + '/tarData/upload.tar.gz'
    try {
      tar.create(
        {
          gzip: true,
          file: destination,
          sync: true,
          C: folderToTar
        },
        ['./']
      )
      // check if tar.gz actually exists
      console.log('Start uploading')

      if (existsSync(destination)) {
        // now, upload it to the container
        const container = await this.docker.getContainer(job.jobId + '-algoritm')

        try {
          // await container2.putArchive(destination, {
          const stream = await container.putArchive(destination, {
            path: '/data'
          })
          console.log('PutArchive')
          console.log(stream)

          console.log('Done uploading')
        } catch (e) {
          console.log('Data upload failed')
          console.log(e)
          return {
            status: C2DStatusNumber.DataUploadFailed,
            statusText: C2DStatusText.DataUploadFailed
          }
        }
      } else {
        CORE_LOGGER.debug('No data to upload, empty tar.gz')
      }
    } catch (e) {
      CORE_LOGGER.debug(e.message)
    }

    rmSync(this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/inputs', {
      recursive: true,
      force: true
    })
    rmSync(this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/transformations', {
      recursive: true,
      force: true
    })
    rmSync(this.getC2DConfig().tempFolder + '/' + job.jobId + '/tarData', {
      recursive: true,
      force: true
    })
    return ret
  }

  // eslint-disable-next-line require-await
  private async makeJobFolders(job: DBComputeJob) {
    try {
      const baseFolder = this.getC2DConfig().tempFolder + '/' + job.jobId
      console.log('BASE FOLDER: ' + baseFolder)
      if (!existsSync(baseFolder)) mkdirSync(baseFolder)
      if (!existsSync(baseFolder + '/data')) mkdirSync(baseFolder + '/data')
      if (!existsSync(baseFolder + '/data/inputs')) mkdirSync(baseFolder + '/data/inputs')
      if (!existsSync(baseFolder + '/data/transformations'))
        mkdirSync(baseFolder + '/data/transformations')
      // ddo directory
      if (!existsSync(baseFolder + '/data/ddos')) {
        mkdirSync(baseFolder + '/data/ddos')
      }
      if (!existsSync(baseFolder + '/data/outputs'))
        mkdirSync(baseFolder + '/data/outputs')
      if (!existsSync(baseFolder + '/data/logs')) mkdirSync(baseFolder + '/data/logs')
      if (!existsSync(baseFolder + '/tarData')) mkdirSync(baseFolder + '/tarData') // used to upload and download data
    } catch (e) {}
  }

  // clean up temporary files
  public override async cleanupExpiredStorage(
    job: DBComputeJob,
    isCleanAfterDownload: boolean = false
  ): Promise<boolean> {
    if (!job) return false
    CORE_LOGGER.info('Cleaning up C2D storage for Job: ' + job.jobId)
    try {
      // delete the storage
      // for free env, the container is deleted as soon as we download the results
      // so we avoid trying to do it again
      if (!isCleanAfterDownload) {
        await this.cleanupJob(job)
      }

      // delete output folders
      await this.deleteOutputFolder(job)
      // delete the job
      await this.db.deleteJob(job.jobId)
      return true
    } catch (e) {
      CORE_LOGGER.error('Error cleaning up C2D storage and Job: ' + e.message)
    }
    return false
  }
}

// this uses the docker engine, but exposes only one env, the free one

export function getAlgorithmImage(algorithm: ComputeAlgorithm): string {
  if (!algorithm.meta || !algorithm.meta.container) {
    return null
  }
  let { image } = algorithm.meta.container
  if (algorithm.meta.container.checksum)
    image = image + '@' + algorithm.meta.container.checksum
  else if (algorithm.meta.container.tag)
    image = image + ':' + algorithm.meta.container.tag
  else image = image + ':latest'
  // console.log('Using image: ' + image)
  return image
}

export function checkManifestPlatform(
  manifestPlatform: any,
  envPlatform?: RunningPlatform
): boolean {
  if (!manifestPlatform || !envPlatform) return true // skips if not present
  if (
    envPlatform.architecture !== manifestPlatform.architecture ||
    envPlatform.os !== manifestPlatform.os
  )
    return false
  return true
}
