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
import fs from 'fs'
// import { getProviderFeeToken } from '../../components/core/utils/feesHandler.js'
import { getConfiguration } from '../../utils/config.js'
import { C2DEngine } from './compute_engine_base.js'
import { C2DDatabase } from '../database/C2DDatabase.js'
import { create256Hash } from '../../utils/crypt.js'
import { Storage } from '../storage/index.js'
import * as k8s from '@kubernetes/client-node'
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

export class C2DEngineK8 extends C2DEngine {
  private envs: ComputeEnvironment[] = []
  protected db: C2DDatabase
  public k8s: any
  private k8sApi: any
  public yamlFolder: string = './resources/c2d_k8_yaml/'
  private cronTimer: any
  private cronTime: number = 2000
  public constructor(clusterConfig: C2DClusterInfo, db: C2DDatabase) {
    super(clusterConfig)
    this.db = db
    this.k8s = null
    this.k8sApi = null
    if (clusterConfig.connection) {
      // Alex config
      clusterConfig.connection = {
        name: 'my-server',
        server: 'https://172.26.53.25:6443',
        user: {
          name: 'kubernetes-admin',
          certData:
            'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURLVENDQWhHZ0F3SUJBZ0lJSVRkQmVDeHBiand3RFFZSktvWklodmNOQVFFTEJRQXdGVEVUTUJFR0ExVUUKQXhNS2EzVmlaWEp1WlhSbGN6QWVGdzB5TkRFeE1EY3dOekEwTVRKYUZ3MHlOVEV4TURjd056QTVNVFZhTUR3eApIekFkQmdOVkJBb1RGbXQxWW1WaFpHMDZZMngxYzNSbGNpMWhaRzFwYm5NeEdUQVhCZ05WQkFNVEVHdDFZbVZ5CmJtVjBaWE10WVdSdGFXNHdnZ0VpTUEwR0NTcUdTSWIzRFFFQkFRVUFBNElCRHdBd2dnRUtBb0lCQVFDMklkT2EKeEkveEVnM0EvQXcyZjQ3UVNpMmxQbUViMGFBUU0rN2l1Rmd6aTkvRmd3RHF1K01kRWxPRTNUam8yM1BJSWE5OQprM25ES0VZc0ZXN21rWERZZVdzM1ZncW12U2tYVXFNLzJJdXZHcEpOZXY1dnJnUG9NSzFYSjFNdzBIcEhjZFhjCm1SR1Z4RVF3UVBqbGsrY0xCdk1LYS9GaVl3R2hCeXEyRmVhNngvbHFJMnZkSnhWM2ZrL2JGOVVvbXZYTzZPdXUKMGlsQkNHYmlBRFlMTCtRZjZOQnVUSDBZb1d6bTNkNnZ3R3RHRGtQWDlpdFllZW1YaGVCQWhTdVVwT3BtM283VgpQbktiQ3dyS1VMRmZIYXFvU3NYcE93R2JPODBGNUtKQ2l5ektTMmlNak4rbTd6RXNWWmpGSjROM3F3MHhaWU1MCnhOU0pHYWRTS2FDN3EzKzFBZ01CQUFHalZqQlVNQTRHQTFVZER3RUIvd1FFQXdJRm9EQVRCZ05WSFNVRUREQUsKQmdnckJnRUZCUWNEQWpBTUJnTlZIUk1CQWY4RUFqQUFNQjhHQTFVZEl3UVlNQmFBRkdpNklzVDZ3UURJeHBhbgo2RitzVnFmemRYUi9NQTBHQ1NxR1NJYjNEUUVCQ3dVQUE0SUJBUURCUFE0RTR3NDZocjFRc01MaWxTeGNwNzJkCnBNUUhwbTFzdTJFWlk2QmJFWjBncmlpVFlhc0VCN1RUWHpJR3h1cTRDemdIUDBWbFE4QmlkSHJIOVZwcm03aEgKWEVjeWFVcHFubG85cWpTWU16dW5XaTYrUUE5SzFPNUhSRDd6MzBHeDkzZzhhTC9ibE1meEpHUjNCTE1SZ1JvUApiamtxVjVVc2gyUnVnKy9EVlRTNG5sQlRMTWlML1BDQkEvRXoxdFZYR1lHSDhjdTdyVnVYMHhWSmxQTVpjYk9ECmZQWGdhamp6dXkxQXF5OGZrLzAxZUtRZGZHbmZHK214WW0xVlR0bk12NmZ5cVQzZ2ZHV1JsNWliYmltamR3d3YKRlZLSDBvY3RlSlVpWmdnMDRVNVhFNE9sb0tYdm90Q1JFR2toRUFkSzR5dk8yT0ovTENzZTNWSXM3UTEvCi0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K',
          keyData:
            'LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQpNSUlFb3dJQkFBS0NBUUVBdGlIVG1zU1A4UklOd1B3TU5uK08wRW90cFQ1aEc5R2dFRFB1NHJoWU00dmZ4WU1BCjZydmpIUkpUaE4wNDZOdHp5Q0d2ZlpONXd5aEdMQlZ1NXBGdzJIbHJOMVlLcHIwcEYxS2pQOWlMcnhxU1RYcisKYjY0RDZEQ3RWeWRUTU5CNlIzSFYzSmtSbGNSRU1FRDQ1WlBuQ3diekNtdnhZbU1Cb1FjcXRoWG11c2Y1YWlOcgozU2NWZDM1UDJ4ZlZLSnIxenVqcnJ0SXBRUWhtNGdBMkN5L2tIK2pRYmt4OUdLRnM1dDNlcjhCclJnNUQxL1lyCldIbnBsNFhnUUlVcmxLVHFadDZPMVQ1eW13c0t5bEN4WHgycXFFckY2VHNCbXp2TkJlU2lRb3NzeWt0b2pJemYKcHU4eExGV1l4U2VEZDZzTk1XV0RDOFRVaVJtblVpbWd1NnQvdFFJREFRQUJBb0lCQURQbU1ia3hkOTczQ1FwTQpDR0xqT0Z2c04xT1dFZS91YlJFUTYycVpvekNWRkIvaE03cXY3WWpVTnc1dVI1QTdNS1AvelZVWVdDTWZiOWVTCkIvY1Z6TFV5N0RWcGhFRjlONTlZd2dJb2Y2MVhBZ2VvRzZiUlRIVzJvVDVyaTA0bXFpRi9zN1JYdmVZU2RtZlYKcTljbnJUZThORGR0Q096RFQ2eUdNVXFQdFI3VjhBNzUvdkt4RzY3WEw1dll5YXNqUTRCWTR1R0V1ZkRkVUdtYgpPU3YvODlzQlZkbVRWV2hmNEI2S0FhNHd1WUJjbDR0SzkzYTZxcDd5N2x4cmoxdXVCa0NZcytTUGpRM0JJcnJ2Cml4ZjZ4NmliZ1pBUkhhWDkzY2tXNjd5Z05VQk5KclRwbDdOeVgyUHo5T2ZxY3NQdXVoK0lhWEFmdTlKcmcrOVIKOFFUcmRHRUNnWUVBMnRZaWQzU1d2SVdLN1FxY2lyOTdkUVgzMUxlSTVqejhCZGpNUnEwdXNUbmhFa1dvOXZkWQo4REVZNjFqK2h6a25SYTY1YTh3aDNtWXh1ZmlNcXc4NnIvN25oak92WHZ3SVYvdXAzZEo1MG5DWFdvOEEyYm9GCmxmeFVDUUZaRy9IdXJYSG9BZzVTWFpvcU1LcE9Oa1ZwRWJ2NmZrS0ttVWNWNlZYbGd0T2RmYmtDZ1lFQTFRLzYKeVg0U09paERwNlNEbXIzVHBhTkh0Vjg2Rko2Sk1DZGFKSW5DYXRzYUt5ZFIvTzNSbmV0VFRvemlxRlloUzRFTwordUdlNGZvOTRoc0pVekxiOERXQmZrSGJLWWxMVVZQV0lnSDcwSnF2YlkwMlZjbHl6dUloWm4vaVBxMmtYcUMvCk5FeThwVFNiUit0N2RiWmlUaXVRbDlxR1dvbXRJUXI2QlFBcEw5MENnWUVBaEtQa01qbDFvQURsaXZXeW1wcWoKVHZQMkduWEFRYVZYTUlnT2tRd3BUL3lBQWw0OG9xeWJ1TUpaazFUV3VjbVhsekhuYTRKSVNRL3lOZ0dENmE4SwphR0I5bnFjM05jQlhvbFNFeWxIbnl2aTVsSWMzQWNFeDM0NFl0WGlldFVSMzRhTTM5LzhNUjNYSStzUlBNYS95CmxuQTB6VkN4eDJRQjBQTmljR0NwaGVrQ2dZQXpNMHpjQU56V2R2aVRIN2kwaGV1SGdXNXBDb0pGbERkNWgrdGsKbm1wSERYSURic2FJRm9wcC9iUWVTMExvbXhJVE4rZG1xTE5xc0owUWFkamEwbjBDQTRtajBxV2RISzRwMUJEQQpTV08vSkgwRndZcU9JUVBpN1hxRFREWU5RK01kRGxvRWNuQmU3djVsMFJQeEhLd1JCdTBQWU9jcWVLMVBKSGtpCm5JQkpUUUtCZ0JGYW0rUi9iaWYzOE9PZnluWHM1aFBoVFZEcUpOQmsrd01Da0l6R2NyVjlwRjRkSXRlanNHbGIKRHlaM0VCdCt4czNtYTE3U3MzTVM5SFRSYlY0OE9STEhqVE9vK2NUTzBHTHN2MkRxRHBVWElqLzdjaDV5OFhNeAprWmpxTDhNbFhJRmhvUHQ5R1RIRUUzNldZTFZ1Q1VuS250elZVQzF1SFNrc2F4dUhVOHoyCi0tLS0tRU5EIFJTQSBQUklWQVRFIEtFWS0tLS0tCg=='
        },
        context: 'kubernetes-admin@kubernetes'
      }
      const cluster = {
        name: clusterConfig.connection.name,
        server: clusterConfig.connection.server,
        skipTLSVerify: true
      }
      const user = {
        name: clusterConfig.connection.user.name,
        certData: clusterConfig.connection.user.certData,
        keyData: clusterConfig.connection.user.keyData
      }
      const context = {
        name: clusterConfig.connection.context,
        cluster: clusterConfig.connection.name,
        user: clusterConfig.connection.user.name
      }
      try {
        const kc = new k8s.KubeConfig()
        kc.loadFromOptions({
          clusters: [cluster],
          users: [user],
          contexts: [context],
          currentContext: context.name
        })

        this.k8sApi = kc.makeApiClient(k8s.CoreV1Api)
      } catch (e) {
        console.error(e)
      }
    }
  }

  // eslint-disable-next-line require-await
  public override async getComputeEnvironments(
    chainId?: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */
    if (!this.k8sApi) return []
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
    if (!this.k8sApi) return []

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
    const job = await this.db.getJob(jobId)
    return job.results
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
    // TO DO
    return null
  }

  // TO DO
  // eslint-disable-next-line require-await
  // public override async getStreamableLogs(jobId: string): Promise<NodeJS.ReadableStream> {
  // }

  private async setNewTimer() {
    // don't set the cron if we don't have compute environments
    if ((await this.getComputeEnvironments()).length > 0)
      this.cronTimer = setInterval(this.InternalLoop.bind(this), this.cronTime)
  }

  private async InternalLoop() {
    // this is the internal loop of k8 cluter
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
       - create pvc & pv
       
       */
    if (job.status === C2DStatusNumber.JobStarted) {
      // pull docker image
      job.status = C2DStatusNumber.ConfiguringVolumes
      job.statusText = C2DStatusText.ConfiguringVolumes
    }

    if (job.status === C2DStatusNumber.ConfiguringVolumes) {
      try {
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
      try {
        job.status = C2DStatusNumber.RunningAlgorithm
        job.statusText = C2DStatusText.RunningAlgorithm
        await this.db.updateJob(job)
      } catch (e) {
        job.status = C2DStatusNumber.ContainerCreationFailed
        job.statusText = C2DStatusText.ContainerCreationFailed
        // C2DStatusNumber.AlgorithmProvisioningFailed
        // C2DStatusText.AlgorithmProvisioningFailed
        // C2DStatusNumber.DataProvisioningFailed
        // C2DStatusText.DataProvisioningFailed
        job.isRunning = false
        await this.db.updateJob(job)
        await this.cleanupJob(job)
      }
      return
    }
    if (job.status === C2DStatusNumber.RunningAlgorithm) {
      job.status = C2DStatusNumber.PublishingResults
      job.statusText = C2DStatusText.PublishingResults
      await this.db.updateJob(job)
    }
    if (job.status === C2DStatusNumber.PublishingResults) {
      // get output
      job.status = C2DStatusNumber.JobFinished
      job.statusText = C2DStatusText.JobFinished
      job.isRunning = false
      await this.db.updateJob(job)
      await this.cleanupJob(job)
    }
  }

  // eslint-disable-next-line require-await
  private async cleanupJob(job: DBComputeJob) {
    // cleaning up
  }

  // clean up temporary files
  // eslint-disable-next-line require-await
  public override async cleanupExpiredStorage(job: DBComputeJob): Promise<boolean> {
    if (!job) return false
    CORE_LOGGER.info('Cleaning up C2D storage for Job: ' + job.jobId)
  }



  //k8 apis
  private async createpvc(name:string,namespace:string,storage:string,storageClass:string){
    const yamlString=await fs.readFileSync(this.yamlFolder+"/pvc.yaml").toString()
    
    const yamlNamespace = k8s.loadYaml(yamlString);
    try {
      const createNamespaceRes = await this.k8sApi.createNamespace(yamlNamespace);
      console.log('Created namespace: ', createNamespaceRes.body);

      const namespaceRes = await this.k8sApi.readNamespace("test");
      console.log('Namespace: ', namespaceRes.body);

      //await k8sApi.deleteNamespace(yamlNamespace.metadata.name, {});
  } catch (err) {
      console.error(err);
  }


}

// this uses the docker engine, but exposes only one env, the free one
export class C2DEngineK8Free extends C2DEngineK8 {
  public constructor(clusterConfig: C2DClusterInfo, db: C2DDatabase) {
    // we remove envs, cause we have our own
    const hash = create256Hash('free' + clusterConfig.hash)
    const owerwrite = {
      type: C2DClusterType.K8,
      hash,
      connection: clusterConfig.connection,
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
    if (!this.k8s) return []
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
}
