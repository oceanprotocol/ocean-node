import {
  TypesenseConfigOptions,
  TypesenseCollectionCreateSchema
} from '../../@types/index.js'
import Typesense from '../../components/database/typesense.js'
import {
  getLoggerLevelEmoji,
  GENERIC_EMOJIS,
  LOG_LEVELS_STR,
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'

const DB_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.DATABASE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

// before running this: "setup-db": "docker-compose -f typesense-compose.yml -p ocean-node up -d",
// nonce schema (address => nonce)
export const nonceSchema: TypesenseCollectionCreateSchema = {
  name: 'nonce',
  enable_nested_fields: true,
  fields: [
    { name: 'address', type: 'string', sort: true },
    { name: 'nonce', type: 'string' } // store nonce as string
  ]
}

const typesenseConfig: TypesenseConfigOptions = {
  apiKey: 'xyz',
  nodes: [
    {
      host: 'localhost',
      port: 8108,
      protocol: 'http'
    }
  ],
  logLevel: LOG_LEVELS_STR.LEVEL_INFO,
  logger: DB_CONSOLE_LOGGER.getLogger(),
  numRetries: 3
}
const typesense = new Typesense(typesenseConfig)

// const typesenseApi: TypesenseApi = new TypesenseApi(typesense.config)

async function createNonceCollection(): Promise<any> {
  try {
    const resultNonce = await typesense.collections().create(nonceSchema)
    DB_CONSOLE_LOGGER.logMessageWithEmoji(
      'Successfully created collection ' +
        nonceSchema.name +
        ' at ' +
        new Date(resultNonce.created_at),
      true,
      GENERIC_EMOJIS.EMOJI_CHECK_MARK
    )
    return resultNonce
  } catch (err) {
    DB_CONSOLE_LOGGER.logMessageWithEmoji(
      'Error creating "nonce" collection: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return null
  }
}

async function createCollections() {
  DB_CONSOLE_LOGGER.logMessage('Creating initial DB collections', true)
  const numCollectionsToLoad = 1
  let loaded = 0
  try {
    const existingCollections = await typesense.collections().retrieve()
    // check existing ones
    if (existingCollections && existingCollections.length > 0) {
      const existsNonceCollection = await typesense
        .collections(nonceSchema.name)
        .retrieve()
      if (existsNonceCollection) {
        // this one already exists
        DB_CONSOLE_LOGGER.logMessageWithEmoji(
          '"nonce" collection already exists, skipping it...',
          true,
          getLoggerLevelEmoji(LOG_LEVELS_STR.LEVEL_WARN),
          LOG_LEVELS_STR.LEVEL_WARN
        )
        loaded++
      }
    } else {
      // create nonce collection
      console.log('HERE?')
      const res = await createNonceCollection()
      if (res) {
        loaded++
      }
    }
  } catch (err) {
    console.log(err)
  } finally {
    DB_CONSOLE_LOGGER.logMessageWithEmoji(
      `Done loading initial DB collections (${loaded} / ${numCollectionsToLoad}) `,
      true,
      GENERIC_EMOJIS.EMOJI_CHECK_MARK
    )
  }
}

createCollections()
