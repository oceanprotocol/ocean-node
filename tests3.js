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
  hash: '0x040b62aff557348958b287a27eb60d1e807f403b09c5bb08a227ad51eb3527122008a5c9a2fb4d9a22336b90cc6d81768c9fc9c2550fbc529ec14234a33fd1e49332c4ed5544fcdb22c40baec62d0b1d07a1b74187f0606882c81e82fdddc8fd600e6e7964225a7b323ac1194dc58908ad281e6ae487e928f47e5d663da486621d62f6da79645b47f64d90a9069140fdfe792c5a65d9abb6ee6fd591216d759d503a1b4abb190cd7a9d72ea4c4aa430ed0dfc390fa0790df2b2d91b9ed882ec90bf68db6951ec93f3e31980f78bdb1b12bed062d15e6e3abc04d0ff3e5ddf03113eceb6fcedd6594b5544f9b90b4a1768fafc329de01f162d76c4a068b48d8ea832cc8d7f8f326e8a1cee4c9210d0d6e29d2bfe0443ca36c111ae8f73e1bdf7dd18b017fc5fe',
  encryptedBy: 'EncryptionKey',
  encryptMethod: 'ECIES'
}

const s3ObjectWASABI = {
  endpoint: 's3.wasabisys.com',
  region: 'eu-central-2',
  objectKey: 'test.json',
  bucket: 'adritest',
  accessKeyId: '',
  secretAccessKey: ''
}

function encrypt(data, algorithm) {
  let encryptedData
  if (algorithm === 'AES') {
    // use first 16 bytes of public key as an initialisation vector
    const initVector = publicKey.subarray(0, 16)
    // creates cipher object, with the given algorithm, key and initialization vector
    const cipher = crypto.createCipheriv('aes-256-cbc', privateKey, initVector)
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
    region: s3Object.region
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
  } catch (error) {
    console.error('Error:', error)
  }
}

async function testEncrypt() {
  const encryptedDataWasabi = await testEncryption(
    s3ObjectWASABI,
    sampleS3FileObjectWASABI.encryptMethod
  )
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
}

testEncrypt().then(testS3Storage())
