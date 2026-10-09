/* eslint-disable security/detect-non-literal-fs-filename */
import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import * as tarStream from 'tar-stream'
import yauzl from 'yauzl'
import { C2DEngineDocker } from '../../components/c2d/compute_engine_docker.js'
import { Storage } from '../../components/storage/index.js'
import { C2DStatusNumber, C2DStatusText } from '../../@types/C2D/C2D.js'

const OWNER = '0x0000000000000000000000000000000000000001'
const VIEWER = '0x0000000000000000000000000000000000000002'

async function buffer(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function outputsTar(empty = false): Promise<Buffer> {
  const tar = tarStream.pack()
  tar.entry({ name: 'outputs', type: 'directory' })
  if (!empty) {
    tar.entry({ name: 'outputs/result.txt' }, 'hello')
    tar.entry({ name: 'outputs/nested/data.txt' }, 'nested')
  }
  tar.finalize()
  return buffer(tar)
}

async function zipContents(bytes: Buffer): Promise<Record<string, string>> {
  const zip = await yauzl.fromBufferPromise(bytes)
  const files: Record<string, string> = {}
  try {
    for await (const entry of zip.eachEntry()) {
      if (!entry.fileName.endsWith('/')) {
        files[entry.fileName] = (
          await buffer(await zip.openReadStreamPromise(entry))
        ).toString()
      }
    }
    return files
  } finally {
    zip.close()
  }
}

describe('compute output archives', () => {
  let folder: string
  let engine: any
  let job: any
  let container: any
  let outputFolder: string

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-job-zip-'))
    job = {
      jobId: 'job-1',
      owner: OWNER,
      additionalViewers: [VIEWER],
      status: C2DStatusNumber.PublishingResults,
      statusText: C2DStatusText.PublishingResults,
      terminationDetails: {}
    }
    container = {
      inspect: sinon.stub().resolves({ State: { OOMKilled: false, ExitCode: 0 } }),
      getArchive: sinon.stub().callsFake(async () => Readable.from(await outputsTar()))
    }
    engine = Object.create(C2DEngineDocker.prototype)
    engine.clusterConfig = { hash: 'cluster', tempFolder: folder + '/' }
    engine.docker = { getContainer: sinon.stub().returns(container) }
    engine.db = {
      getJob: sinon.stub().resolves([job]),
      updateJob: sinon.stub().resolves()
    }
    engine.collectJobMetrics = sinon.stub().resolves()
    engine.recordJobFinished = sinon.stub()
    engine.cleanupJob = sinon.stub().resolves()
    outputFolder = path.join(engine.getStoragePath(), job.jobId, 'data/outputs')
    fs.mkdirSync(outputFolder, { recursive: true })
  })

  afterEach(() => {
    sinon.restore()
    fs.rmSync(folder, { recursive: true, force: true })
  })

  it('publishes ZIP contents before cleanup, then lists and serves actual bytes', async () => {
    engine.cleanupJob.callsFake(() => {
      expect(fs.existsSync(path.join(outputFolder, 'outputs.zip'))).to.equal(true)
      expect(fs.existsSync(path.join(outputFolder, 'outputs.zip.partial'))).to.equal(
        false
      )
      return Promise.resolve()
    })
    await engine.processJob(job)
    const bytes = fs.readFileSync(path.join(outputFolder, 'outputs.zip'))
    expect(await zipContents(bytes)).to.deep.equal({
      'result.txt': 'hello',
      'nested/data.txt': 'nested'
    })
    const results = await engine.getResults(job.jobId)
    expect(results).to.deep.equal([
      { filename: 'outputs.zip', filesize: bytes.length, type: 'output', index: 0 }
    ])
    const response = await engine.getComputeJobResult(OWNER, job.jobId, 0)
    expect(response.headers['Content-Type']).to.equal('application/zip')
    expect(response.headers['Content-Disposition']).to.include('job-1-outputs.zip')
    expect(response.headers['Content-Length']).to.equal(String(bytes.length))
    expect(await buffer(response.stream)).to.deep.equal(bytes)
    expect(job.status).to.equal(C2DStatusNumber.JobSettle)
  })

  it('resumes the same stored ZIP for an additional viewer, including EOF', async () => {
    await engine.processJob(job)
    const bytes = fs.readFileSync(path.join(outputFolder, 'outputs.zip'))
    const response = await engine.getComputeJobResult(VIEWER, job.jobId, 0, 11)
    expect(await buffer(response.stream)).to.deep.equal(bytes.subarray(11))
    expect(response.headers['Content-Length']).to.equal(String(bytes.length - 11))
    const end = await engine.getComputeJobResult(OWNER, job.jobId, 0, bytes.length)
    expect(await buffer(end.stream)).to.have.length(0)
  })

  it('keeps legacy TAR bytes and metadata readable, preferring ZIP when both exist', async () => {
    const legacy = await outputsTar()
    fs.writeFileSync(path.join(outputFolder, 'outputs.tar'), legacy)
    expect((await engine.getResults(job.jobId))[0].filename).to.equal('outputs.tar')
    const response = await engine.getComputeJobResult(OWNER, job.jobId, 0, 7)
    expect(response.headers['Content-Type']).to.equal('application/x-tar')
    expect(await buffer(response.stream)).to.deep.equal(legacy.subarray(7))
    await engine.processJob(job)
    expect((await engine.getResults(job.jobId))[0].filename).to.equal('outputs.zip')
    expect(fs.readFileSync(path.join(outputFolder, 'outputs.tar'))).to.deep.equal(legacy)
  })

  it('rejects unauthorized readers and invalid offsets', async () => {
    await engine.processJob(job)
    for (const offset of [-1, 0.5, NaN, 100000]) {
      try {
        await engine.getComputeJobResult(OWNER, job.jobId, 0, offset)
        expect.fail('invalid offset accepted')
      } catch (error) {
        expect(error.message).to.include('Invalid result offset')
      }
    }
    try {
      await engine.getComputeJobResult(
        '0x0000000000000000000000000000000000000003',
        job.jobId,
        0
      )
      expect.fail('unauthorized reader accepted')
    } catch (error) {
      expect(error.message).to.include('is not authorized')
    }
  })

  it('preserves log results as separate text downloads', async () => {
    const logs = path.join(engine.getStoragePath(), job.jobId, 'data/logs')
    fs.mkdirSync(logs, { recursive: true })
    fs.writeFileSync(path.join(logs, 'algorithm.log'), 'log line')
    await engine.processJob(job)
    const results = await engine.getResults(job.jobId)
    expect(results.map((result: any) => result.type)).to.deep.equal([
      'algorithmLog',
      'output'
    ])
    const response = await engine.getComputeJobResult(OWNER, job.jobId, 0)
    expect(response.headers['Content-Type']).to.equal('text/plain')
    expect((await buffer(response.stream)).toString()).to.equal('log line')
  })

  it('publishes a valid empty ZIP', async () => {
    container.getArchive.callsFake(async () => Readable.from(await outputsTar(true)))
    await engine.processJob(job)
    expect(
      await zipContents(fs.readFileSync(path.join(outputFolder, 'outputs.zip')))
    ).to.deep.equal({})
  })

  it('removes partial archives and reports failure on a broken Docker TAR', async () => {
    const tar = await outputsTar()
    container.getArchive.resolves(Readable.from(tar.subarray(0, 530)))
    await engine.processJob(job)
    expect(job.status).to.equal(C2DStatusNumber.ResultsUploadFailed)
    expect(fs.readdirSync(outputFolder)).to.deep.equal([])
    expect(engine.cleanupJob.calledOnce).to.equal(true)
  })

  it('skips archiving for output buckets', async () => {
    job.outputBucketId = 'bucket-1'
    await engine.processJob(job)
    expect(container.getArchive.called).to.equal(false)
    expect(await engine.getResults(job.jobId)).to.deep.equal([])
    expect(fs.readdirSync(outputFolder)).to.deep.equal([])
  })

  it('uploads ZIP before optional encryption with a matching filename', async () => {
    job.output = '00'
    engine.keyManager = {
      decrypt: sinon.stub().resolves(
        Buffer.from(
          JSON.stringify({
            remoteStorage: {},
            encryption: { key: '00', encryptMethod: 'AES' }
          })
        )
      ),
      encryptStream: sinon.stub().callsFake((stream: Readable) => stream)
    }
    const upload = sinon.stub().callsFake(async (name: string, stream: Readable) => {
      expect(name).to.equal('outputs-cluster-job-1.zip')
      expect(await zipContents(await buffer(stream))).to.deep.equal({
        'result.txt': 'hello',
        'nested/data.txt': 'nested'
      })
    })
    sinon.stub(Storage, 'getStorageClass').returns({ hasUpload: true, upload } as any)
    await engine.processJob(job)
    expect(upload.calledOnce).to.equal(true)
    expect(engine.keyManager.encryptStream.calledOnce).to.equal(true)
    expect(job.status).to.equal(C2DStatusNumber.JobSettle)
    expect(fs.readdirSync(outputFolder)).to.deep.equal([])
  })

  it('falls back to local ZIP for remote storage without upload support', async () => {
    job.output = '00'
    engine.keyManager = {
      decrypt: sinon.stub().resolves(Buffer.from('{"remoteStorage":{}}'))
    }
    sinon.stub(Storage, 'getStorageClass').returns({ hasUpload: false } as any)
    await engine.processJob(job)
    expect(
      await zipContents(fs.readFileSync(path.join(outputFolder, 'outputs.zip')))
    ).to.deep.equal({ 'result.txt': 'hello', 'nested/data.txt': 'nested' })
    expect((await engine.getResults(job.jobId))[0].filename).to.equal('outputs.zip')
  })
})
