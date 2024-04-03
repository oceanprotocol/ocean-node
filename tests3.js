import AWS from 'aws-sdk'
import crypto from 'crypto'
import eciesjs from 'eciesjs'
import { hexlify, ethers } from 'ethers'
import { Readable } from 'stream'

const privateKey = ''
const publicKey = ''

const sampleS3FileObjectOCEAN = {
  type: 's3',
  hash: '0x04dd7bc604cc6fe33180de92bc2fe4bf7c894e350ad6cbbfe9a4a69b9c615e7c6b0e276fb1f9e1d741174e2d1869d28c88010e2b6cbb013a5389814040d3ad1448ad8e41ec8e3484e1fe7bf2420cc375814bbe4418e00282fc06e712621a1855dd74bf92584351298a8d9198bc4a609de1bcf9e3cb67646e9237ad1f07e89af641254e9e702a48f8e3423690e4867aec9355851f2134c211c5c93756cfaf2279f882f4955f7c35072b88a3bf723e350c7877504d94290b6b397c2cc57d38af66c4d6b4414f215fe31b45ab16e3a6377b8d430b0b3f35687a7e9909031f6854c0da97c568592432f328e28108cc8d567c06d4d968f4fe6b1311f7f37f06d498a5ebf7b55c59cb4643671d9a4bca64487a08befd05d42429adb84cf3ca1d92a37826562494e94504bfa4e5331bc3392ecf8a1ee007ab',
  encryptedBy: 'EncryptionKey',
  encryptMethod: 'ECIES'
}

const s3ObjectOcean = {
  endpoint: 'fra1.digitaloceanspaces.com:',
  region: 'fra1',
  objectKey: 'test.json',
  bucket: 'mybuckettestadri',
  accessKeyId: '',
  secretAccessKey: ''
}

const sampleS3FileObjectAWS = {
  type: 's3',
  hash: '0x04dd7bc604cc6fe33180de92bc2fe4bf7c894e350ad6cbbfe9a4a69b9c615e7c6b0e276fb1f9e1d741174e2d1869d28c88010e2b6cbb013a5389814040d3ad1448ad8e41ec8e3484e1fe7bf2420cc375814bbe4418e00282fc06e712621a1855dd74bf92584351298a8d9198bc4a609de1bcf9e3cb67646e9237ad1f07e89af641254e9e702a48f8e3423690e4867aec9355851f2134c211c5c93756cfaf2279f882f4955f7c35072b88a3bf723e350c7877504d94290b6b397c2cc57d38af66c4d6b4414f215fe31b45ab16e3a6377b8d430b0b3f35687a7e9909031f6854c0da97c568592432f328e28108cc8d567c06d4d968f4fe6b1311f7f37f06d498a5ebf7b55c59cb4643671d9a4bca64487a08befd05d42429adb84cf3ca1d92a37826562494e94504bfa4e5331bc3392ecf8a1ee007ab',
  encryptedBy: 'EncryptionKey',
  encryptMethod: 'ECIES'
}

const s3ObjectAWS = {
  endpoint: 's3.amazonaws.com',
  region: 'eu-north-1',
  objectKey: 'test.json',
  bucket: 'mybucketadriantest',
  accessKeyId: '',
  secretAccessKey: ''
}

const sampleS3FileObjectWASABI = {
  type: 's3',
  hash: '0x6080d8e89754e342e7821a5cfc50944960be74b5c55b0c139697cda91689e3d2e6b06021eb11581d213c5e26584f3264b2800b471bce724e6b9b224adab7208de762f64dda773af2ac13a2a261fc15ac4239c1ac631e75640162b4c761033596eec8fb0290f79180fce23fc0c46ee621eb6f6b15fec6e77ae68c24fec93c2de80bba6e0365ee2604650437130364cd6ba80cabaea0753ebe638066c5b3242286994b9f6e389fdc86d092c1e68730eeece686924f78a2a50cdcf71ff2ce65a3a4bae39a04a35638f7dbb9289b845d51ff',
  //hash: '0x040b62aff557348958b287a27eb60d1e807f403b09c5bb08a227ad51eb3527122008a5c9a2fb4d9a22336b90cc6d81768c9fc9c2550fbc529ec14234a33fd1e49332c4ed5544fcdb22c40baec62d0b1d07a1b74187f0606882c81e82fdddc8fd600e6e7964225a7b323ac1194dc58908ad281e6ae487e928f47e5d663da486621d62f6da79645b47f64d90a9069140fdfe792c5a65d9abb6ee6fd591216d759d503a1b4abb190cd7a9d72ea4c4aa430ed0dfc390fa0790df2b2d91b9ed882ec90bf68db6951ec93f3e31980f78bdb1b12bed062d15e6e3abc04d0ff3e5ddf03113eceb6fcedd6594b5544f9b90b4a1768fafc329de01f162d76c4a068b48d8ea832cc8d7f8f326e8a1cee4c9210d0d6e29d2bfe0443ca36c111ae8f73e1bdf7dd18b017fc5fe',
  encryptedBy: 'EncryptionKey',
  //encryptMethod: 'ECIES'
  encryptMethod: 'AES'
}

const s3ObjectWASABI = {
  endpoint: 's3.wasabisys.com',
  region: 'eu-central-2',
  objectKey: 'test.json',
  bucket: 'adritest',
  accessKeyId: '',
  secretAccessKey: ''
}

const sampleS3FileObjectBACKBLAZE = {
  type: 's3',
  hash: '0x047ac7694f57010a18fe6b95dce2b59804414a203b28c3f19fd409b214f421681e4c104aa5cb057f4ba2baacf87950e3675004b3be34b50400c179c3711c8fa8e40a26f5161a4517a26beb86af4158b9e2d03075b2ef6a694bbdbbdc071d60cd46d417b9a42757d85c7989d2652aecdec89d094f352c17ccd0673f0d83143367cdd6487eaa817f8fdef57044dd7595387e38256fa85b3b9fe82e085639022324fbbf2a2d6bfceb76e73084352279897620ede9e606defc71f6480b1eeb35fb615874e4bb9d537bb18cb2d723350e5d1d67b00cc36a70c7ce2a1113764a13366473f3cd56e85db1cce0355b01cfa410496d92975f16d7b64d3a69e30942cd4ce71c20d2e1bf0493610c2aacc8ff1414eaf85ba4d0af3693cb51a400844529904eddb96af6763cf65657582e373067e75063eeb1b3d1',
  encryptedBy: 'EncryptionKey',
  encryptMethod: 'ECIES'
}

const s3ObjectBACKBLAZE = {
  endpoint: 's3.us-east-005.backblazeb2.com',
  region: 'us-east-005',
  objectKey: 'test.json',
  bucket: 'adritestbucket',
  accessKeyId: '',
  secretAccessKey: ''
}

function encrypt(data, algorithm) {
  let encryptedData
  if (algorithm === 'AES') {
    const publicKeyBuffer = Buffer.from(publicKey.slice(2), 'hex')
    // use first 16 bytes of public key as an initialisation vector
    const initVector = publicKeyBuffer.subarray(0, 16)
    const privateKeyBuffer = Buffer.from(privateKey, 'hex')
    // creates cipher object, with the given algorithm, key and initialization vector
    const cipher = crypto.createCipheriv('aes-256-cbc', privateKeyBuffer, initVector)
    // encoding is ignored because we are working with bytes and want to return a buffer
    encryptedData = Buffer.concat([cipher.update(data), cipher.final()])
  } else if (algorithm === 'ECIES') {
    const sk = new eciesjs.PrivateKey(privateKey)
    // get public key from Elliptic curve
    encryptedData = eciesjs.encrypt(sk.publicKey.toHex(), data)
  }
  return encryptedData
}

export async function streamToString(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString()
}

async function decryptData(hash, algorithm) {
  const fileStream = Readable.from(hash)
  const streamString = await streamToString(fileStream)
  const encryptedData = ethers.getBytes(streamString)

  let data
  if (algorithm === 'ECIES') {
    const privateKeyBuffer = Buffer.from(privateKey, 'hex')
    const sk = new eciesjs.PrivateKey(privateKeyBuffer)
    data = eciesjs.decrypt(sk.secret, encryptedData)
  } else if (algorithm === 'AES') {
    const publicKeyBuffer = Buffer.from(publicKey.slice(2), 'hex')
    const initVector = publicKeyBuffer.subarray(0, 16)
    const privateKeyBuffer = Buffer.from(privateKey, 'hex')
    const decipher = crypto.createDecipheriv('aes-256-cbc', privateKeyBuffer, initVector)
    data = Buffer.concat([decipher.update(encryptedData), decipher.final()])
  } else {
    throw new Error('Unsupported encryption algorithm')
  }
  const dataJson = JSON.parse(data.toString())
  return dataJson
}

async function fetchSpecificFileMetadataTest(fileObject) {
  const s3Object = await decryptData(fileObject.hash, fileObject.encryptMethod)
  const spacesEndpoint = new AWS.Endpoint(s3Object.endpoint)
  const s3 = new AWS.S3({
    endpoint: spacesEndpoint,
    accessKeyId: s3Object.accessKeyId,
    secretAccessKey: s3Object.secretAccessKey,
    region: s3Object.region,
    s3ForcePathStyle: true
  })

  const params = {
    Bucket: s3Object.bucket,
    Key: s3Object.objectKey
  }
  try {
    const data = await s3.getObject(params).promise()
    console.log('Successfully retrieved object from S3')
    const jsonData = JSON.parse(data.Body.toString('utf-8'))
    console.log('jsonData:', jsonData)
  } catch (err) {
    console.error('Error fetching object from S3:', err)
  }
  return {
    valid: true,
    contentLength: 'unknown',
    contentType: 'unknown',
    name: '',
    type: 's3',
    encryptedBy: fileObject.encryptedBy,
    encryptMethod: fileObject.encryptMethod
  }
}

async function testEncryption(obj, algorithm) {
  const genericAssetData = Uint8Array.from(Buffer.from(JSON.stringify(obj)))
  const encryptedData = encrypt(genericAssetData, algorithm)
  const encryptedMetaData = hexlify(encryptedData)
  return encryptedMetaData
}

async function testS3Storage() {
  try {
    await fetchSpecificFileMetadataTest(sampleS3FileObjectOCEAN)
    console.log('ocean ok')

    console.log('--------------------------------------------------------')
    await fetchSpecificFileMetadataTest(sampleS3FileObjectAWS)
    console.log('aws ok')

    console.log('-------------------------------------')
    await fetchSpecificFileMetadataTest(sampleS3FileObjectWASABI)
    console.log('wasabi ok')

    console.log('-------------------------------------')
    await fetchSpecificFileMetadataTest(sampleS3FileObjectBACKBLAZE)
    console.log('backblaze ok')
  } catch (error) {
    console.error('Error:', error)
  }
}

async function testEncrypt() {
  const encryptedDataWasabi = await testEncryption(s3ObjectWASABI, 'AES')
  console.log('\nencrypt for wasabi ok', encryptedDataWasabi)
  const decryptedDataWASABI = await decryptData(
    encryptedDataWasabi,
    sampleS3FileObjectWASABI.encryptMethod
  )
  console.log('\ndecryptedDataWASABI', decryptedDataWASABI)
  const encryptedDataAWS = await testEncryption(
    s3ObjectAWS,
    sampleS3FileObjectAWS.encryptMethod
  )
  console.log('\nencrypt for aws ok', encryptedDataAWS)
  const decryptedDataAWS = await decryptData(
    encryptedDataAWS,
    sampleS3FileObjectAWS.encryptMethod
  )
  console.log('\ndecryptedDataAWS', decryptedDataAWS)

  const encryptedDataOCEAN = await testEncryption(
    s3ObjectOcean,
    sampleS3FileObjectOCEAN.encryptMethod
  )
  console.log('\nencrypt for ocean ok', encryptedDataOCEAN)
  const decryptedDataOCEAN = await decryptData(
    encryptedDataOCEAN,
    sampleS3FileObjectOCEAN.encryptMethod
  )
  console.log('\ndecryptedDataOCEAN', decryptedDataOCEAN)

  const encryptedDataBACKBLAZE = await testEncryption(
    s3ObjectBACKBLAZE,
    sampleS3FileObjectBACKBLAZE.encryptMethod
  )
  console.log('\nencrypt for backblaze ok', encryptedDataBACKBLAZE)
  const decryptedDataBACKBLAZE = await decryptData(
    encryptedDataBACKBLAZE,
    sampleS3FileObjectOCEAN.encryptMethod
  )
  console.log('\ndecryptedDataBACKBLAZE', decryptedDataBACKBLAZE)
}

testEncrypt()
testS3Storage()
