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
  ComputeResult
} from '../../@types/C2D/C2D.js'
import { ZeroAddress } from 'ethers'
// import { getProviderFeeToken } from '../../components/core/utils/feesHandler.js'
import { getConfiguration } from '../../utils/config.js'
import { C2DEngine } from './compute_engine_base.js'
import { C2DDatabase } from '../database/C2DDatabase.js'
import { create256Hash } from '../../utils/crypt.js'
import { Storage } from '../storage/index.js'
import Dockerode from 'dockerode'
import type { ContainerCreateOptions, VolumeCreateOptions } from 'dockerode'
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
    return this.envs
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
    // NOTE: this does not generate a unique ID...
    // if i send 2 times the same startComputeJob parameters i get the same ID twice
    //  const jobId = create256Hash(
    //   JSON.stringify({
    //     assets,
    //     algorithm,
    //     output,
    //     environment,
    //     owner,
    //     validUntil,
    //     chainId,
    //     agreementId
    //   })
    // )
    // TO DO C2D - Check image, check arhitecture, etc
    let { image } = algorithm.meta.container
    if (algorithm.meta.container.checksum)
      image = image + '@' + algorithm.meta.container.checksum
    else if (algorithm.meta.container.tag)
      image = image + ':' + algorithm.meta.container.checksum
    else image = image + ':latest'
    console.log('Using image: ' + image)

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
    const cjob: ComputeJob = JSON.parse(JSON.stringify(job)) as ComputeJob
    // we add cluster hash to user output
    // cjob.jobId = this.getC2DConfig().hash + '-' + cjob.jobId
    cjob.jobId = jobId
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
    const logStat = statSync(
      this.getC2DConfig().tempFolder + '/' + jobId + '/data/logs/algorithmLog'
    )
    if (logStat) {
      res.push({
        filename: 'algorithmLog',
        filesize: logStat.size,
        type: 'algorithmLog',
        index
      })
      index = index + 1
    }
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
    return res
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]> {
    const job = await this.db.getJob(jobId)
    if (!job) {
      return []
    }
    const res: ComputeJob = job as ComputeJob
    // add results for algoLogs
    res.results = await this.getResults(job.jobId)
    return [res]
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number
  ): Promise<Readable> {
    const job = await this.db.getJob(jobId)
    if (!job || job.owner !== consumerAddress) {
      return null
    }
    const results = await this.getResults(jobId)
    for (const i of results) {
      if (i.index === index) {
        if (i.type === 'algorithmLog') {
          return createReadStream(
            this.getC2DConfig().tempFolder + '/' + jobId + '/data/logs/algorithmLog'
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
    const job = await this.db.getJob(jobId)
    if (!job) return null
    if (!job.isRunning) return null
    try {
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
    console.log('Got jobs for engine ' + this.getC2DConfig().hash)
    console.log(jobs)
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
    console.log('Process job started')
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
      await this.docker.pull(job.containerImage)
      job.status = C2DStatusNumber.PullImage
      job.statusText = C2DStatusText.PullImage
      await this.db.updateJob(job)
      return // now we wait until image is ready
    }
    if (job.status === C2DStatusNumber.PullImage) {
      try {
        const imageInfo = await this.docker.getImage(job.containerImage)
        // console.log(imageInfo)
        const details = await imageInfo.inspect()
        console.log(details)
        job.status = C2DStatusNumber.ConfiguringVolumes
        job.statusText = C2DStatusText.ConfiguringVolumes
        await this.db.updateJob(job)
        // now we can move forward
      } catch (e) {
        // not ready yet
        // console.log(e)
      }
      return
    }
    if (job.status === C2DStatusNumber.ConfiguringVolumes) {
      // create the volume & create container
      // TO DO C2D:  Choose driver & size
      const volume: VolumeCreateOptions = {
        Name: job.jobId + '-volume'
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
      const hostConfig: any = {
        Mounts: [
          {
            Type: 'volume',
            Source: volume.Name,
            Target: '/data',
            ReadOnly: false
          }
        ]
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
      // TO DO - fix the following
      if (job.algorithm.meta.container.entrypoint) {
        const newEntrypoint = job.algorithm.meta.container.entrypoint.replace(
          '$ALGO',
          '/data/transformation/algorithm'
        )
        containerInfo.Entrypoint = newEntrypoint
      }
      try {
        const container = await this.docker.createContainer(containerInfo)
        console.log(container)
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
        this.getC2DConfig().tempFolder + '/' + job.jobId + '/data/logs/algorithmLog',
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
    // download algo
    if (job.algorithm.fileObject) {
      console.log(job.algorithm.fileObject)
      const storage = Storage.getStorageClass(job.algorithm.fileObject, config)

      const fullAlgoPath =
        this.getC2DConfig().tempFolder +
        '/' +
        job.jobId +
        '/data/transformations/algorithm'
      try {
        await pipeline(
          (await storage.getReadableStream()).stream,
          createWriteStream(fullAlgoPath)
        )
      } catch (e) {
        console.log(e)
        return {
          status: C2DStatusNumber.AlgorithmProvisioningFailed,
          statusText: C2DStatusText.AlgorithmProvisioningFailed
        }
      }
    }
    for (const i in job.assets) {
      const asset = job.assets[i]
      console.log(asset)
      // without this check it would break if no fileObject is present
      if (asset.fileObject) {
        const storage = Storage.getStorageClass(asset.fileObject, config)
        const fileInfo = await storage.getFileInfo({
          type: storage.getStorageType(asset.fileObject)
        })
        const fullPath =
          this.getC2DConfig().tempFolder +
          '/' +
          job.jobId +
          '/data/inputs/' +
          fileInfo[0].name

        try {
          await pipeline(
            (await storage.getReadableStream()).stream,
            createWriteStream(fullPath)
          )
        } catch (e) {
          console.log(e)
          return {
            status: C2DStatusNumber.DataProvisioningFailed,
            statusText: C2DStatusText.DataProvisioningFailed
          }
        }
      }
    }
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
      if (!existsSync(baseFolder)) mkdirSync(baseFolder)
      if (!existsSync(baseFolder + '/data')) mkdirSync(baseFolder + '/data')
      if (!existsSync(baseFolder + '/data/inputs')) mkdirSync(baseFolder + '/data/inputs')
      if (!existsSync(baseFolder + '/data/transformations'))
        mkdirSync(baseFolder + '/data/transformations')
      if (!existsSync(baseFolder + '/data/outputs'))
        mkdirSync(baseFolder + '/data/outputs')
      if (!existsSync(baseFolder + '/data/logs')) mkdirSync(baseFolder + '/data/logs')
      if (!existsSync(baseFolder + '/tarData')) mkdirSync(baseFolder + '/tarData') // used to upload and download data
    } catch (e) {}
  }

  // clean up temporary files
  public override async cleanupExpiredStorage(job: DBComputeJob): Promise<boolean> {
    if (!job) return false
    CORE_LOGGER.info('Cleaning up C2D storage for Job: ' + job.jobId)
    try {
      // delete the storage
      await this.cleanupJob(job)
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
        keyPath: clusterConfig.connection.keyPath
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
    const cpuType = ''
    const currentJobs = 0
    const consumerAddress = ''
    const envs: ComputeEnvironment[] = [
      {
        id: `${this.getC2DConfig().hash}-free`,
        cpuNumber: 1,
        cpuType,
        gpuNumber: 0,
        ramGB: 1,
        diskGB: 1,
        priceMin: 0,
        desc: 'Free',
        currentJobs,
        maxJobs: 1,
        consumerAddress,
        storageExpiry: 600,
        maxJobDuration: 30,
        feeToken: ZeroAddress,
        free: true
      }
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
        const job = await this.db.getJob(jobId)
        CORE_LOGGER.info(
          'Cleaning storage for free container, after retrieving results...'
        )
        this.cleanupExpiredStorage(job) // clean the storage, do not wait for it to expire
      }, 5000)
    }
    return result
  }
}
