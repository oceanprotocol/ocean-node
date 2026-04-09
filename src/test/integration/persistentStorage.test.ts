import { expect } from 'chai'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { getAddress, JsonRpcProvider, Signer } from 'ethers'

import { Database } from '../../components/database/index.js'
import {
  PersistentStorageCreateBucketHandler,
  PersistentStorageDeleteFileHandler,
  PersistentStorageGetBucketsHandler,
  PersistentStorageGetFileObjectHandler,
  PersistentStorageListFilesHandler,
  PersistentStorageUploadFileHandler
} from '../../components/core/handler/persistentStorage.js'
import { OceanNode } from '../../OceanNode.js'
import type { AccessList } from '../../@types/AccessList.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { getConfiguration } from '../../utils/config.js'
import { streamToObject } from '../../utils/util.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment,
  sleep
} from '../utils/utils.js'
import { createHashForSignature, safeSign } from '../utils/signature.js'

import { BlockchainRegistry } from '../../components/BlockchainRegistry/index.js'
import { Blockchain } from '../../utils/blockchain.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { DEVELOPMENT_CHAIN_ID } from '../../utils/address.js'
import { deployAndGetAccessListConfig } from '../utils/contracts.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { KeyManager } from '../../components/KeyManager/index.js'

describe('Persistent storage handlers (integration)', function () {
  this.timeout(DEFAULT_TEST_TIMEOUT)

  let previousConfiguration: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let database: Database
  let oceanNode: OceanNode
  let consumer: Signer
  let psRoot: string

  let provider: JsonRpcProvider
  let blockchain: Blockchain
  let owner: Signer
  let wallets: Signer[] = []
  let forbiddenConsumer: Signer
  let bucketAllowList: any

  before(async () => {
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    config = await getConfiguration() // Force reload the configuration

    wallets = [
      (await provider.getSigner(0)) as Signer,
      (await provider.getSigner(1)) as Signer,
      (await provider.getSigner(2)) as Signer,
      (await provider.getSigner(3)) as Signer
    ]
    forbiddenConsumer = (await provider.getSigner(4)) as Signer

    const rpcs: RPCS = config.supportedNetworks
    const chain: SupportedNetwork = rpcs[String(DEVELOPMENT_CHAIN_ID)]
    const keyManager = new KeyManager(config)
    const blockchains = new BlockchainRegistry(keyManager, config)
    blockchain = blockchains.getBlockchain(chain.chainId)

    owner = await blockchain.getSigner()

    // ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST
    const accessListPublishers = await deployAndGetAccessListConfig(
      owner,
      provider,
      wallets
    )
    bucketAllowList = accessListPublishers
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.PRIVATE_KEY],
        ['0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58']
      )
    )

    config = await getConfiguration(true)
    psRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocean-ps-it-'))
    config.persistentStorage = {
      enabled: true,
      type: 'localfs',
      accessLists: [bucketAllowList],
      options: { folder: psRoot }
    }

    database = await Database.init(config.dbConfig)
    oceanNode = await OceanNode.getInstance(
      config,
      database,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )

    consumer = (await provider.getSigner(1)) as Signer
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    // await fsp.rm(psRoot, { recursive: true, force: true })
  })

  it('create bucket → upload → list → delete (happy path)', async () => {
    const consumerAddress = await consumer.getAddress()
    let nonce = Date.now().toString()
    let messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    let signature = await safeSign(consumer, messageHashBytes)

    const createRes = await new PersistentStorageCreateBucketHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress,
      signature,
      nonce,
      accessLists: [],
      authorization: undefined
    } as any)

    expect(createRes.status.httpStatus).to.equal(200)
    expect(createRes.stream).to.be.instanceOf(Readable)
    const created = await streamToObject(createRes.stream as Readable)
    expect(created.bucketId).to.be.a('string')
    expect(getAddress(created.owner)).to.equal(getAddress(consumerAddress))
    const bucketId = created.bucketId as string

    const fileName = 'hello.txt'
    const body = Buffer.from('persistent-storage-it')

    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE
    )
    signature = await safeSign(consumer, messageHashBytes)
    const uploadRes = await new PersistentStorageUploadFileHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE,
      consumerAddress,
      signature,
      nonce,
      bucketId,
      fileName,
      stream: Readable.from(body)
    } as any)
    expect(uploadRes.status.httpStatus).to.equal(200)
    const uploaded = await streamToObject(uploadRes.stream as Readable)
    expect(uploaded.name).to.equal(fileName)
    expect(uploaded.size).to.equal(body.length)
    await sleep(1000)
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_LIST_FILES
    )
    signature = await safeSign(consumer, messageHashBytes)
    const listRes = await new PersistentStorageListFilesHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_LIST_FILES,
      consumerAddress,
      signature,
      nonce,
      bucketId,
      authorization: undefined
    } as any)

    expect(listRes.status.httpStatus).to.equal(200)
    const listed = await streamToObject(listRes.stream as Readable)
    expect(listed).to.be.an('array')
    expect(listed.some((f: { name: string }) => f.name === fileName)).to.equal(true)
    await sleep(1000)
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_DELETE_FILE
    )
    signature = await safeSign(consumer, messageHashBytes)
    const delRes = await new PersistentStorageDeleteFileHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_DELETE_FILE,
      consumerAddress,
      signature,
      nonce,
      chainId: 8996,
      bucketId,
      fileName,
      authorization: undefined
    } as any)

    expect(delRes.status.httpStatus).to.equal(200)
    await sleep(1000)
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_LIST_FILES
    )
    signature = await safeSign(consumer, messageHashBytes)
    const listAfterDel = await new PersistentStorageListFilesHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_LIST_FILES,
      consumerAddress,
      signature,
      nonce,
      bucketId,
      authorization: undefined
    } as any)
    expect(listAfterDel.status.httpStatus).to.equal(200)
    const listedAfter = await streamToObject(listAfterDel.stream as Readable)
    expect(listedAfter.some((f: { name: string }) => f.name === fileName)).to.equal(false)
  })

  it('getFileObject returns a file object for an allowed consumer', async () => {
    const consumerAddress = await consumer.getAddress()

    let nonce = Date.now().toString()
    let messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    let signature = await safeSign(consumer, messageHashBytes)

    const createRes = await new PersistentStorageCreateBucketHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress,
      signature,
      nonce,
      accessLists: [],
      authorization: undefined
    } as any)
    expect(createRes.status.httpStatus).to.equal(200)
    const created = await streamToObject(createRes.stream as Readable)
    const bucketId = created.bucketId as string

    const fileName = 'obj.txt'
    const body = Buffer.from('file-object')
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE
    )
    signature = await safeSign(consumer, messageHashBytes)
    const uploadRes = await new PersistentStorageUploadFileHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE,
      consumerAddress,
      signature,
      nonce,
      bucketId,
      fileName,
      stream: Readable.from(body)
    } as any)
    expect(uploadRes.status.httpStatus).to.equal(200)

    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_FILE_OBJECT
    )
    signature = await safeSign(consumer, messageHashBytes)
    const objRes = await new PersistentStorageGetFileObjectHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_FILE_OBJECT,
      consumerAddress,
      signature,
      nonce,
      bucketId,
      fileName,
      authorization: undefined
    } as any)
    expect(objRes.status.httpStatus).to.equal(200)
    const obj = await streamToObject(objRes.stream as Readable)
    expect(obj).to.be.an('object')
    expect(obj.bucketId).to.equal(bucketId)
    expect(obj.fileName).to.equal(fileName)
  })

  it('should not create bucket when consumer is not on allow list', async () => {
    const forbiddenConsumerAddress = await forbiddenConsumer.getAddress()
    const nonce = Date.now().toString()
    const messageHashBytes = createHashForSignature(
      forbiddenConsumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    const signature = await safeSign(forbiddenConsumer, messageHashBytes)

    const res = await new PersistentStorageCreateBucketHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress: forbiddenConsumerAddress,
      signature,
      nonce,
      accessLists: [],
      authorization: undefined
    } as any)

    expect(res.status.httpStatus).to.equal(403)
    expect(res.status.error).to.contain('not allowed')
  })

  it('should deny forbiddenConsumer for bucket operations when bucket has accessList', async () => {
    // Create a bucket whose ACL allows only wallets[0..3]
    const consumerAddress = await consumer.getAddress()
    let nonce = Date.now().toString()
    let messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    let signature = await safeSign(consumer, messageHashBytes)

    const createRes = await new PersistentStorageCreateBucketHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress,
      signature,
      nonce,
      accessLists: [bucketAllowList],
      authorization: undefined
    } as any)

    expect(createRes.status.httpStatus).to.equal(200)
    const created = await streamToObject(createRes.stream as Readable)
    const bucketId = created.bucketId as string

    // Forbidden consumer tries to list files -> should fail
    const forbiddenConsumerAddress = await forbiddenConsumer.getAddress()
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      forbiddenConsumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_LIST_FILES
    )
    signature = await safeSign(forbiddenConsumer, messageHashBytes)
    const listRes = await new PersistentStorageListFilesHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_LIST_FILES,
      consumerAddress: forbiddenConsumerAddress,
      signature,
      nonce,
      bucketId,
      authorization: undefined
    } as any)
    expect(listRes.status.httpStatus).to.equal(403)
    expect(listRes.status.error).to.contain('not allowed')

    // Forbidden consumer tries to upload -> should fail
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      forbiddenConsumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE
    )
    signature = await safeSign(forbiddenConsumer, messageHashBytes)
    const uploadRes = await new PersistentStorageUploadFileHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE,
      consumerAddress: forbiddenConsumerAddress,
      signature,
      nonce,
      bucketId,
      fileName: 'forbidden.txt',
      stream: Readable.from(Buffer.from('nope')),
      authorization: undefined
    } as any)
    expect(uploadRes.status.httpStatus).to.equal(403)
    expect(uploadRes.status.error).to.contain('not allowed')
  })

  it('getFileObject should fail for forbiddenConsumer when bucket has accessList', async () => {
    // Create a bucket whose ACL allows only wallets[0..3]
    const consumerAddress = await consumer.getAddress()
    let nonce = Date.now().toString()
    let messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    let signature = await safeSign(consumer, messageHashBytes)

    const createRes = await new PersistentStorageCreateBucketHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress,
      signature,
      nonce,
      accessLists: [bucketAllowList],
      authorization: undefined
    } as any)
    expect(createRes.status.httpStatus).to.equal(200)
    const created = await streamToObject(createRes.stream as Readable)
    const bucketId = created.bucketId as string

    const fileName = 'forbidden-obj.txt'
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE
    )
    signature = await safeSign(consumer, messageHashBytes)
    const uploadRes = await new PersistentStorageUploadFileHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_UPLOAD_FILE,
      consumerAddress,
      signature,
      nonce,
      bucketId,
      fileName,
      stream: Readable.from(Buffer.from('secret'))
    } as any)
    expect(uploadRes.status.httpStatus).to.equal(200)

    const forbiddenConsumerAddress = await forbiddenConsumer.getAddress()
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      forbiddenConsumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_FILE_OBJECT
    )
    signature = await safeSign(forbiddenConsumer, messageHashBytes)

    const objRes = await new PersistentStorageGetFileObjectHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_FILE_OBJECT,
      consumerAddress: forbiddenConsumerAddress,
      signature,
      nonce,
      bucketId,
      fileName,
      authorization: undefined
    } as any)

    expect(objRes.status.httpStatus).to.equal(403)
    expect(objRes.status.error).to.contain('not allowed')
  })

  it('getFileObject should fail when file does not exist', async () => {
    const consumerAddress = await consumer.getAddress()

    let nonce = Date.now().toString()
    let messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    let signature = await safeSign(consumer, messageHashBytes)

    const createRes = await new PersistentStorageCreateBucketHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress,
      signature,
      nonce,
      accessLists: [],
      authorization: undefined
    } as any)
    expect(createRes.status.httpStatus).to.equal(200)
    const created = await streamToObject(createRes.stream as Readable)
    const bucketId = created.bucketId as string

    const missingFileName = 'missing.txt'
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_FILE_OBJECT
    )
    signature = await safeSign(consumer, messageHashBytes)

    const objRes = await new PersistentStorageGetFileObjectHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_FILE_OBJECT,
      consumerAddress,
      signature,
      nonce,
      bucketId,
      fileName: missingFileName,
      authorization: undefined
    } as any)
    expect(objRes.status.httpStatus).to.equal(404)
    expect(objRes.status.error?.toLowerCase()).to.contain('file not found')
  })

  it('deleteFile should fail when file does not exist', async () => {
    const consumerAddress = await consumer.getAddress()

    let nonce = Date.now().toString()
    let messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    let signature = await safeSign(consumer, messageHashBytes)

    const createRes = await new PersistentStorageCreateBucketHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress,
      signature,
      nonce,
      accessLists: [],
      authorization: undefined
    } as any)
    expect(createRes.status.httpStatus).to.equal(200)
    const created = await streamToObject(createRes.stream as Readable)
    const bucketId = created.bucketId as string

    const missingFileName = 'missing-delete.txt'
    nonce = Date.now().toString()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_DELETE_FILE
    )
    signature = await safeSign(consumer, messageHashBytes)

    const delRes = await new PersistentStorageDeleteFileHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_DELETE_FILE,
      consumerAddress,
      signature,
      nonce,
      chainId: 8996,
      bucketId,
      fileName: missingFileName,
      authorization: undefined
    } as any)
    expect(delRes.status.httpStatus).to.equal(500)
    expect(delRes.status.error?.toLowerCase()).to.contain('file not found')
  })

  it('getBuckets returns buckets the consumer can access', async () => {
    const consumerAddress = await consumer.getAddress()
    await sleep(1000)
    let nonce = Date.now()
    let messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_BUCKETS
    )
    let signature = await safeSign(consumer, messageHashBytes)
    const beforeCreate = await new PersistentStorageGetBucketsHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_BUCKETS,
      consumerAddress,
      signature,
      nonce,
      chainId: 8996,
      owner: consumerAddress,
      authorization: undefined
    } as any)
    expect(beforeCreate.status.httpStatus).to.equal(200)
    const beforeList = await streamToObject(beforeCreate.stream as Readable)
    expect(beforeList).to.be.an('array')
    await sleep(1000)
    nonce = Date.now()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    signature = await safeSign(consumer, messageHashBytes)
    const createRes = await new PersistentStorageCreateBucketHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress,
      signature,
      nonce,
      accessLists: [],
      authorization: undefined
    } as any)
    expect(createRes.status.httpStatus).to.equal(200)
    const created = await streamToObject(createRes.stream as Readable)
    const newBucketId = created.bucketId as string
    await sleep(1000)
    nonce = Date.now()
    messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_BUCKETS
    )
    signature = await safeSign(consumer, messageHashBytes)
    const afterCreate = await new PersistentStorageGetBucketsHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_GET_BUCKETS,
      consumerAddress,
      signature,
      nonce,
      chainId: 8996,
      owner: consumerAddress,
      authorization: undefined
    } as any)
    expect(afterCreate.status.httpStatus).to.equal(200)
    const afterList = await streamToObject(afterCreate.stream as Readable)
    expect(afterList).to.be.an('array')
    const found = afterList.find((b: { bucketId: string }) => b.bucketId === newBucketId)
    expect(found).to.be.an('object')
    expect(found.createdAt).to.be.a('number')
    expect(getAddress(found.owner)).to.equal(getAddress(consumerAddress))
    expect(found.accessLists).to.be.an('array')
    expect(afterList.length).to.be.at.least(beforeList.length + 1)
  })

  it('create bucket validate fails when accessLists is missing', async () => {
    const consumerAddress = await consumer.getAddress()
    await sleep(1000)
    const nonce = Date.now().toString()
    const messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    const signature = await safeSign(consumer, messageHashBytes)
    const validation = await new PersistentStorageCreateBucketHandler(oceanNode).validate(
      {
        command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
        consumerAddress,
        signature,
        nonce
      } as any
    )

    expect(validation.valid).to.equal(false)
    expect(validation.reason).to.contain('accessLists')
  })

  it('returns error when persistent storage is disabled', async () => {
    const disabledConfig = {
      ...config,
      persistentStorage: {
        enabled: false,
        type: 'localfs' as const,
        accessLists: [] as AccessList[],
        options: { folder: psRoot }
      }
    }
    const nodeDisabled = await OceanNode.getInstance(
      disabledConfig,
      database,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )

    const consumerAddress = await consumer.getAddress()
    await sleep(1000)
    const nonce = Date.now().toString()
    const messageHashBytes = createHashForSignature(
      consumerAddress,
      nonce,
      PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET
    )
    const signature = await safeSign(consumer, messageHashBytes)

    const res = await new PersistentStorageCreateBucketHandler(nodeDisabled).handle({
      command: PROTOCOL_COMMANDS.PERSISTENT_STORAGE_CREATE_BUCKET,
      consumerAddress,
      signature,
      nonce,
      accessLists: [],
      authorization: undefined
    } as any)

    expect(res.status.httpStatus).to.equal(500)
    expect(res.status.error).to.match(/not configured|disabled/i)
  })
})
