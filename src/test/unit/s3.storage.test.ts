import { expect } from 'chai'
import { EncryptMethod, S3FileObject, S3Object } from '../../@types/fileObject.js'
import { Readable } from 'stream'
import { S3Storage } from '../../components/storage/index.js'

describe('S3 Storage tests', () => {
  let s3Storage: S3Storage
  let s3ObjectOcean: S3Object

  beforeEach(() => {
    const s3FileObject: S3FileObject = {
      type: 's3',
      hash: '0x04e8b3a7b4bcf9225567343ebadbf7b886177d0282e9cc8598f7b26c622a4361aea6faf98ddd03d7b802e09444536d1982272b50c95786439ad2d4e8cf38a07289872a9c6995eb5a2c87f4ef5131b929ecc887298ae4232d5ff82cad822f91bc502429ca98593d5cb14dce0af63ca98f17671cb21efbcc78e8a3212d103b30dd78b37441812bf418733ba21e1010aa75884ae8517b1749039677b24665513c8462e4c916b5f482da44b22b2bcbe06cb729847ece5df2fee24e334201ed3de3193046062904f9ac6e0d6af70b4b3ceaa81fce3a3f265cccddf9d4c50b3ebf1eda53ebbd98d49799936008144109478d3678e422c1eb807f6aef650eb6f6177278274308e46b17a980fd9cb23aa3e958f1d9071c9b9ae89b6b9a558081916d0efef497c04d42e1d706f6d28d74a867ec2d6e2f194c',
      encryptedBy: '16Uiu2HAm7YHuXeBpoFoKHyAieKDAsdg3RNmCUEVgNxffByRS7Hdt',
      encryptMethod: EncryptMethod.ECIES
    }
    s3Storage = new S3Storage(s3FileObject)

    s3ObjectOcean = {
      endpoint: 'fra1.digitaloceanspaces.com',
      region: 'fra1',
      objectKey: 'test.json',
      bucket: 'mybuckettestadri',
      accessKeyId: '',
      secretAccessKey: ''
    }
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
  it('should crypt and decrypt file metadata', async () => {
    const cryptedHash = await s3Storage.encryptDataContent(
      s3ObjectOcean,
      EncryptMethod.ECIES
    )
    const decryptedData = await s3Storage.decryptDataContent(
      cryptedHash,
      EncryptMethod.ECIES
    )
    const dataJson = JSON.parse(decryptedData.toString())
    expect(dataJson.endpoint).to.be.equals(s3ObjectOcean.endpoint)
  })

  it('should fetch data from s3', async () => {
    const data = await s3Storage.fetchData()
    const jsonData = JSON.parse(data.Body.toString('utf-8'))
    expect(jsonData.test).to.be.equals(1)
  })

  it('should fetch fetchSpecificFileMetadata from s3', async () => {
    const data = await s3Storage.fetchSpecificFileMetadata()
    expect(data.encryptMethod).to.be.equals(EncryptMethod.ECIES)
    expect(data.name).to.be.equals(s3ObjectOcean.objectKey)
  })
})
