import axios from 'axios'
import { PurgatoryAccounts, PurgatoryAssets } from '../../@types/purgatory.js'
import { Database } from '../database/index.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

export class Purgatory {
  db: Database
  bannedAssets: Array<string>
  bannedAccounts: Array<string>

  constructor(db: Database) {
    this.db = db
    this.bannedAssets = []
    this.bannedAccounts = []
  }

  parsePurgatoryAssets(data: any): Array<PurgatoryAssets> {
    const purgatoryAssets: Array<PurgatoryAssets> = []
    for (const asset of JSON.parse(data)) {
      if (asset && 'did' in asset) {
        purgatoryAssets.push({ did: asset.did, reason: asset.reason })
      }
    }
    return purgatoryAssets
  }

  parsePurgatoryAccounts(data: any): Array<PurgatoryAccounts> {
    const purgatoryAccounts: Array<PurgatoryAccounts> = []
    for (const account of JSON.parse(data)) {
      if (account && 'address' in account) {
        purgatoryAccounts.push({ address: account.address, reason: account.reason })
      }
    }
    return purgatoryAccounts
  }

  async retrievePurgatoryList(
    envVarName: string
  ): Promise<Array<PurgatoryAssets> | Array<PurgatoryAccounts>> {
    if (envVarName !== 'ASSET_PURGATORY_URL' && envVarName !== 'ACCOUNT_PURGATORY_URL') {
      INDEXER_LOGGER.logMessage(`Invalid env var name for purgatory file URL.`, true)
      return
    }
    try {
      const response = await axios({
        method: 'get',
        url: process.env[envVarName],
        timeout: 5
      })
      if (response.status !== 200) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `PURGATORY: Failure when retrieving new purgatory list from ${envVarName} env var.
              Response: ${response.data}, status: ${
                response.status + response.statusText
              }`,
          true
        )
        return
      }
      INDEXER_LOGGER.logMessage(
        `PURGATORY: Successfully retrieved new purgatory list from ${envVarName} env var.`
      )
      switch (envVarName) {
        case 'ASSET_PURGATORY_URL':
          return this.parsePurgatoryAssets(response.data)
        case 'ACCOUNT_PURGATORY_URL':
          return this.parsePurgatoryAccounts(response.data)
        default:
          break
      }
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error fetching purgatory list: ${err}`,
        true
      )
    }
  }
}
