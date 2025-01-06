/* eslint-disable security/detect-non-literal-fs-filename */
import { Readable } from 'stream'
import { C2DClusterType, C2DStatusNumber, C2DStatusText } from '../../@types/C2D/C2D.js'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput,
  DBComputeJob,
  ComputeResult,
  RunningPlatform
} from '../../@types/C2D/C2D.js'
import { getConfiguration } from '../../utils/config.js'
import { C2DEngine } from './compute_engine_base.js'
import { C2DDatabase } from '../database/C2DDatabase.js'
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
import { generateUniqueID } from '../database/sqliteCompute.js'
import { Blockchain } from '../../utils/blockchain.js'
import { AssetUtils } from '../../utils/asset.js'
import { FindDdoHandler } from '../core/handler/ddoHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { Service } from '../../@types/DDO/Service.js'
import { decryptFilesObject, omitDBComputeFieldsFromComputeJob } from './index.js'
import * as drc from 'docker-registry-client'
import { ValidateParams } from '../httpRoutes/validateCommands.js'
// import { convertGigabytesToBytes } from '../../utils/util.js'

export class C2DEngineDocker extends C2DEngine {
  private envs: ComputeEnvironment[] = []
  protected db: C2DDatabase
  public docker: Dockerode
  private cronTimer: any
  private cronTime: number = 2000
  public constructor(clusterConfig: C2DClusterInfo, db: C2DDatabase) {
    super(clusterConfig)
    this.db = db
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

    if (clusterConfig.connection?.environments) {
      this.envs = clusterConfig.connection.environments
    }
    // only when we got the first request to start a compute job,
    // no need to start doing this right away
    // this.setNewTimer()
  }

  // eslint-disable-next-line require-await
  public override async getComputeEnvironments(
    chainId?: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */
    if (!this.docker) return []

    if (chainId) {
      const config = await getConfiguration()
      const supportedNetwork = config.supportedNetworks[chainId]
      if (supportedNetwork) {
        const blockchain = new Blockchain(
          supportedNetwork.rpc,
          supportedNetwork.network,
          chainId,
          supportedNetwork.fallbackRPCs
        )

        // write the consumer address (compute env address)
        const consumerAddress = await blockchain.getWalletAddress()
        const filteredEnvs = []
        for (const computeEnv of this.envs) {
          if (computeEnv.chainId === chainId) {
            computeEnv.consumerAddress = consumerAddress
            filteredEnvs.push(computeEnv)
          }
        }
        return filteredEnvs
      }
      // no compute envs or network is not supported
      CORE_LOGGER.error(`There are no free compute environments for network ${chainId}`)
      return []
    }
    return this.envs
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
    owner?: string,
    validUntil?: number,
    chainId?: number,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    if (!this.docker) return []

    const jobId = generateUniqueID()

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
    const envIdWithHash = environment && environment.indexOf('-') > -1
    const env = await this.getComputeEnvironment(
      chainId,
      envIdWithHash ? environment : null,
      environment
    )

    const validation = await C2DEngineDocker.checkDockerImage(
      image,
      env.platform && env.platform.length > 0 ? env.platform[0] : null
    )
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
      agreementId,
      expireTimestamp: Date.now() / 1000 + validUntil,
      environment,
      configlogURL: null,
      publishlogURL: null,
      algologURL: null,
      outputsURL: null,
      stopRequested: false,
      isRunning: true,
      isStarted: false
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
    return null
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
  ): Promise<Readable> {
    const jobs = await this.db.getJob(jobId, null, consumerAddress)
    if (jobs.length === 0) {
      return null
    }
    const results = await this.getResults(jobId)
    for (const i of results) {
      if (i.index === index) {
        if (i.type === 'algorithmLog') {
          return createReadStream(
            this.getC2DConfig().tempFolder + '/' + jobId + '/data/logs/algorithm.log'
          )
        }
        if (i.type === 'output') {
          return createReadStream(
            this.getC2DConfig().tempFolder + '/' + jobId + '/data/outputs/outputs.tar'
          )
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
            (err, res) => {
              // onFinished
              if (err) return reject(err)
              CORE_LOGGER.info('############# Pull docker image complete ##############')
              resolve(res)
            },
            (progress) => {
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
        await this.db.deleteJob(job.jobId)
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
        console.log('ERROR: Unable to inspect', e.message)
      }
      return
    }
    if (job.status === C2DStatusNumber.ConfiguringVolumes) {
      // create the volume & create container
      // TO DO C2D:  Choose driver & size
      // get env info
      const environment = await this.getJobEnvironment(job)

      const volume: VolumeCreateOptions = {
        Name: job.jobId + '-volume'
      }
      // volume
      if (environment != null) {
        volume.DriverOpts = {
          size: environment.diskGB > 0 ? `${environment.diskGB}G` : '1G'
        }
      }
      try {
        await this.docker.createVolume(volume)
      } catch (e) {
        job.status = C2DStatusNumber.VolumeCreationFailed
        job.statusText = C2DStatusText.VolumeCreationFailed
        job.isRunning = false
        await this.db.updateJob(job)
        await this.cleanupJob(job)
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
      if (environment != null) {
        // TODO the CPU and MEM part is addressed in the PR #799 https://github.com/oceanprotocol/ocean-node/pull/799/
        // REMOVE AFTER MERGE
        // limit container CPU & Memory usage according to env specs
        // hostConfig.CpuCount = environment.cpuNumber || 1
        // // if more than 1 CPU
        // if (hostConfig.CpuCount > 1) {
        //   hostConfig.CpusetCpus = `0-${hostConfig.CpuCount - 1}`
        // }
        // hostConfig.Memory = 0 || convertGigabytesToBytes(environment.ramGB)
        // // set swap to same memory value means no swap (otherwise it use like 2X mem)
        // hostConfig.MemorySwap = hostConfig.Memory

        // storage (container)
        hostConfig.StorageOpt = {
          size: environment.diskGB > 0 ? `${environment.diskGB}G` : '1G'
        }
      }
      // console.log('host config: ', hostConfig)
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

      if (job.algorithm.meta.container.entrypoint) {
        const newEntrypoint = job.algorithm.meta.container.entrypoint.replace(
          '$ALGO',
          'data/transformations/algorithm'
        )
        containerInfo.Entrypoint = newEntrypoint.split(' ')
      }

      try {
        const container = await this.docker.createContainer(containerInfo)
        console.log('container: ', container)
        job.status = C2DStatusNumber.Provisioning
        job.statusText = C2DStatusText.Provisioning
        await this.db.updateJob(job)
      } catch (e) {
        job.status = C2DStatusNumber.ContainerCreationFailed
        job.statusText = C2DStatusText.ContainerCreationFailed
        job.isRunning = false
        await this.db.updateJob(job)
        await this.cleanupJob(job)
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
            await this.db.updateJob(job)
            return
          } catch (e) {
            // container failed to start
            console.error('could not start container: ' + e.message)
            console.log(e)
            job.status = C2DStatusNumber.AlgorithmFailed
            job.statusText = C2DStatusText.AlgorithmFailed
            job.algologURL = String(e)
            job.isRunning = false
            await this.db.updateJob(job)
            await this.cleanupJob(job)
            return
          }
        }
      } else {
        // is running, we need to stop it..
        console.log('running, need to stop it?')
        const timeNow = Date.now() / 1000
        console.log('timeNow: ' + timeNow + ' , Expiry: ' + job.expireTimestamp)
        if (timeNow > job.expireTimestamp || job.stopRequested) {
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
          await this.db.updateJob(job)
          return
        } else {
          if (details.State.Running === false) {
            job.isStarted = false
            job.status = C2DStatusNumber.PublishingResults
            job.statusText = C2DStatusText.PublishingResults
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
        job.status = C2DStatusNumber.ResultsFetchFailed
        job.statusText = C2DStatusText.ResultsFetchFailed
      }
      job.isRunning = false
      await this.db.updateJob(job)
      await this.cleanupJob(job)
    }
  }

  // eslint-disable-next-line require-await
  private async cleanupJob(job: DBComputeJob) {
    // cleaning up
    //  - get algo logs
    //  - delete volume
    //  - delete container

    const container = await this.docker.getContainer(job.jobId + '-algoritm')
    try {
      writeFileSync(
        this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/logs/algorithm.log',
        await container.logs({
          stdout: true,
          stderr: true,
          follow: false
        })
      )
    } catch (e) {
      console.log(e)
    }

    await container.remove()
    const volume = await this.docker.getVolume(job.jobId + '-volume')
    await volume.remove()
    // remove folders
    rmSync(this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/inputs', {
      recursive: true,
      force: true
    })
    rmSync(this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/transformations', {
      recursive: true,
      force: true
    })
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

    console.log(job.algorithm.fileObject)
    const fullAlgoPath =
      this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/transformations/algorithm'
    try {
      let storage = null
      // do we have a files object?
      if (job.algorithm.fileObject) {
        // is it unencrypted?
        if (job.algorithm.fileObject.type) {
          // we can get the storage directly
          storage = Storage.getStorageClass(job.algorithm.fileObject, config)
        } else {
          // ok, maybe we have this encrypted instead
          CORE_LOGGER.info('algorithm file object seems to be encrypted, checking it...')
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
    tar.create(
      {
        gzip: true,
        file: destination,
        sync: true,
        C: folderToTar
      },
      ['./']
    )
    // now, upload it to the container
    const container = await this.docker.getContainer(job.jobId + '-algoritm')

    console.log('Start uploading')
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
export class C2DEngineDockerFree extends C2DEngineDocker {
  public constructor(clusterConfig: C2DClusterInfo, db: C2DDatabase) {
    // we remove envs, cause we have our own
    const hash = create256Hash('free' + clusterConfig.hash)
    const owerwrite = {
      type: C2DClusterType.DOCKER,
      hash,
      connection: {
        socketPath: clusterConfig.connection.socketPath,
        protocol: clusterConfig.connection.protocol,
        host: clusterConfig.connection.host,
        port: clusterConfig.connection.port,
        caPath: clusterConfig.connection.caPath,
        certPath: clusterConfig.connection.certPath,
        keyPath: clusterConfig.connection.keyPath,
        freeComputeOptions: clusterConfig.connection.freeComputeOptions
      },
      tempFolder: './c2d_storage/' + hash
    }
    super(owerwrite, db)
  }

  // eslint-disable-next-line require-await
  public override async getComputeEnvironments(
    chainId?: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */
    // TO DO C2D - fill consts below
    if (!this.docker) return []
    // const cpuType = ''
    // const currentJobs = 0
    // const consumerAddress = ''
    if (chainId) {
      const config = await getConfiguration()
      const supportedNetwork = config.supportedNetworks[chainId]
      if (supportedNetwork) {
        const blockchain = new Blockchain(
          supportedNetwork.rpc,
          supportedNetwork.network,
          chainId,
          supportedNetwork.fallbackRPCs
        )

        // write the consumer address (compute env address)
        const consumerAddress = await blockchain.getWalletAddress()
        const computeEnv: ComputeEnvironment =
          this.getC2DConfig().connection?.freeComputeOptions
        if (computeEnv.chainId === chainId) {
          computeEnv.consumerAddress = consumerAddress
          const envs: ComputeEnvironment[] = [computeEnv]
          return envs
        }
      }
      // no compute envs or network is not supported
      CORE_LOGGER.error(`There are no free compute environments for network ${chainId}`)
      return []
    }
    // get them all
    const envs: ComputeEnvironment[] = [
      this.getC2DConfig().connection?.freeComputeOptions
    ]
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
    // since it's a free job, we need to mangle some params
    agreementId = create256Hash(
      JSON.stringify({
        owner,
        assets,
        algorithm,
        time: process.hrtime.bigint().toString()
      })
    )
    chainId = 0
    const envs = await this.getComputeEnvironments()
    if (envs.length < 1) {
      // no free env ??
      throw new Error('No free env found')
    }
    validUntil = envs[0].maxJobDuration
    return await super.startComputeJob(
      assets,
      algorithm,
      output,
      environment,
      owner,
      validUntil,
      chainId,
      agreementId
    )
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number
  ): Promise<Readable> {
    const result = await super.getComputeJobResult(consumerAddress, jobId, index)
    if (result !== null) {
      setTimeout(async () => {
        const jobs: DBComputeJob[] = await this.db.getJob(jobId)
        CORE_LOGGER.info(
          'Cleaning storage for free container, after retrieving results...'
        )
        if (jobs.length === 1) {
          this.cleanupExpiredStorage(jobs[0], true) // clean the storage, do not wait for it to expire
        }
      }, 5000)
    }
    return result
  }
}

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
  console.log('Using image: ' + image)
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
