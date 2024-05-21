import { expect } from 'chai'
import { EncryptMethod, S3FileObject, S3Object } from '../../@types/fileObject.js'
import { Readable, Transform } from 'stream'
import { S3Storage } from '../../components/storage/index.js'

describe('S3 Storage tests', () => {
  let s3Storage: S3Storage
  let s3Object: S3Object

  console.log('process.env.ACCESS_KEY_ID_S3', process.env.ACCESS_KEY_ID_S3)

  beforeEach(() => {
    s3Object = {
      endpoint: 'fra1.digitaloceanspaces.com',
      region: 'fra1',
      objectKey: 'test.json',
      bucket: 'mybuckettestadri',
      accessKeyId: process.env.ACCESS_KEY_ID_S3,
      secretAccessKey: process.env.SECRET_ACCESS_KEY_S3
    }
    const s3FileObject: S3FileObject = {
      type: 's3',
      s3Access: s3Object,
      encryptedBy: '16Uiu2HAm7YHuXeBpoFoKHyAieKDAsdg3RNmCUEVgNxffByRS7Hdt',
      encryptMethod: EncryptMethod.ECIES
    }
    s3Storage = new S3Storage(s3FileObject)
  })

  it('should create an instance of S3Storage', () => {
    expect(s3Storage).to.be.an.instanceOf(S3Storage)
  })

  it('should validate S3 file object successfully', () => {
    const [isValid, message] = s3Storage.validate()
    // eslint-disable-next-line no-unused-expressions
    expect(isValid).to.be.true
    // eslint-disable-next-line no-unused-expressions
    expect(message).to.be.empty
  })

  it('should parse decrypted stream correctly', async () => {
    const decryptedStream = Readable.from('{"key": "value"}')
    const parsedData = await s3Storage.parseDecryptedStream(decryptedStream)
    expect(parsedData).to.deep.equal({ key: 'value' })
  })

  it('should fetch data from s3', () => {
    const result = s3Storage.getDownloadUrl()
    expect(result).to.be.equal(JSON.stringify(s3Object))
  })

  it('should fetch data from s3', async () => {
    const data = await s3Storage.fetchDataStream()

    const jsonTransformStream = new Transform({
      transform(chunk, encoding, callback) {
        const json = JSON.parse(chunk.toString('utf-8'))
        callback(null, JSON.stringify(json))
      }
    })

    // Pipe the data stream through the JSON transform stream
    const dataJson = data.pipe(jsonTransformStream)
    let transformedJson = ''

    const streamFinishedPromise = new Promise<void>((resolve, reject) => {
      dataJson.on('data', (chunk: any) => {
        transformedJson += chunk
      })
      dataJson.on('finish', () => {
        resolve()
      })
      dataJson.on('error', (err: any) => {
        console.error('Error reading stream:', err)
        reject(err)
      })
    })

    await streamFinishedPromise

    const jsonData = JSON.parse(transformedJson)

    expect(jsonData.test).to.equal(1)
  })

  it('should fetch fetchSpecificFileMetadata from s3', async () => {
    const data = await s3Storage.fetchSpecificFileMetadata()
    expect(data.encryptMethod).to.be.equals(EncryptMethod.ECIES)
    expect(data.name).to.be.equals(s3Object.objectKey)
    expect(data.contentType).to.be.equals('application/json')
  })
})
