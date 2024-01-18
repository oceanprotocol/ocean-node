import { TypesenseCollectionCreateSchema } from '../../@types/index.js'
import { Typesense, convertTypesenseConfig } from '../../components/database/typesense.js'
import {
  getLoggerLevelEmoji,
  GENERIC_EMOJIS,
  LOG_LEVELS_STR
} from '../../utils/logging/Logger.js'

import { ethers } from 'ethers'
import { checkNonce } from '../../components/core/utils/nonceHandler.js'
import { getConfig } from '../../utils/config.js'
import { OceanNode } from '../../OceanNode.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { Database } from '../../components/database/index.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'

const config = await getConfig()
const dbconn = await new Database(config.dbConfig) // carefull! db constructor is async
const p2pNode = new OceanP2P(config, dbconn)
const oceanNode = new OceanNode(config, dbconn, p2pNode, null, null)

// before running this: "setup-db": "docker-compose -f typesense-compose.yml -p ocean-node up -d",
// nonce schema (address => nonce)
export const nonceSchema: TypesenseCollectionCreateSchema = {
  name: 'nonce',
  enable_nested_fields: true,
  fields: [
    { name: 'id', type: 'string' },
    { name: 'nonce', type: 'int64', sort: true } // store nonce as number
  ]
}

const url = process.env.DB_URL || 'http://localhost:8108/?apiKey=xyz'
const typesense = new Typesense(convertTypesenseConfig(url))

// const typesenseApi: TypesenseApi = new TypesenseApi(typesense.config)

async function createNonceCollection(): Promise<any> {
  try {
    const resultNonce = await typesense.collections().create(nonceSchema)
    DATABASE_LOGGER.logMessageWithEmoji(
      'Successfully created collection ' +
        nonceSchema.name +
        ' at ' +
        new Date(resultNonce.created_at),
      true,
      GENERIC_EMOJIS.EMOJI_CHECK_MARK
    )
    return resultNonce
  } catch (err) {
    DATABASE_LOGGER.logMessageWithEmoji(
      'Error creating "nonce" collection: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return null
  }
}

async function dropCollection(name: string) {
  try {
    await typesense.collections(name).delete()
  } catch (err) {
    DATABASE_LOGGER.logMessageWithEmoji(
      `Error deleting "${name}" collection: ` + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_WARN
    )
  }
}

async function createCollections() {
  DATABASE_LOGGER.logMessage('Creating initial DB collections', true)
  const numCollectionsToLoad = 1
  let loaded = 0
  try {
    const existingCollections = await typesense.collections().retrieve()
    // check existing ones
    if (existingCollections && existingCollections.length > 0) {
      let existsNonceCollection = true
      try {
        await typesense.collections(nonceSchema.name).retrieve()
        // exists ?
      } catch (err) {
        existsNonceCollection = false
      }

      if (existsNonceCollection) {
        // this one already exists
        DATABASE_LOGGER.logMessageWithEmoji(
          '"nonce" collection already exists, skipping it...',
          true,
          getLoggerLevelEmoji(LOG_LEVELS_STR.LEVEL_WARN),
          LOG_LEVELS_STR.LEVEL_WARN
        )
        loaded++
      } else {
        // create nonce collection
        const res = await createNonceCollection()
        if (res) loaded++
      }
    } else {
      // none exists, create nonce collection
      const res = await createNonceCollection()
      if (res) loaded++
    }
  } catch (err) {
    DATABASE_LOGGER.logMessageWithEmoji(
      `Error on createCollections: ` + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_WARN
    )
  } finally {
    DATABASE_LOGGER.logMessageWithEmoji(
      `Done loading initial DB collections (${loaded} / ${numCollectionsToLoad}) `,
      true,
      GENERIC_EMOJIS.EMOJI_CHECK_MARK
    )
  }
}

async function createNonceData(address: string, nonce: number): Promise<boolean> {
  try {
    await typesense.collections('nonce').documents().create({
      id: address,
      nonce
    })
    return true
  } catch (err) {
    return false
  }
}

async function getNonceData(consumer: string): Promise<number> {
  let doc
  try {
    doc = await typesense.collections('nonce').documents().retrieve(consumer)
    return doc ? doc.nonce : 0
  } catch (ex) {
    return 0
  }
}

async function doNonceTrackingFlow() {
  // consumer address
  const address = '0x8F292046bb73595A978F4e7A131b4EBd03A15e8a'
  const firstNonce = 1
  // drop if exists
  await dropCollection(nonceSchema.name)
  // recreate the nonce collection
  await createCollections()
  // create firs nonce as '1'
  await createNonceData(address, firstNonce)
  // get previously stored from DB
  const previousNonce = await getNonceData(address)
  DATABASE_LOGGER.logMessage(
    `previous stored nonce for ${address}: ${previousNonce}`,
    true
  )
  // sign the nonce > than previously stored
  const wallet = new ethers.Wallet(
    '0xbee525d70c715bee6ca15ea5113e544d13cc1bb2817e07113d0af7755ddb6391'
  )
  const nextNonce = previousNonce + 1
  const signature = await wallet.signMessage(String(nextNonce))
  DATABASE_LOGGER.logMessage(
    'Next nonce: ' + nextNonce + ' signature: ' + signature,
    true
  )

  const checkNonceresult = await checkNonce(
    oceanNode.getP2PNode(),
    address,
    nextNonce,
    signature
  )
  DATABASE_LOGGER.logMessage(
    'checkNonce => is valid nonce and signature?: ' + checkNonceresult.valid,
    true
  )
}

doNonceTrackingFlow()
