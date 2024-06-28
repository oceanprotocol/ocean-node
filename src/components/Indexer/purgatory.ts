import axios from 'axios'
import { PurgatoryAccounts, PurgatoryAssets } from '../../@types/Purgatory.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { URLUtils } from '../../utils/url.js'
import { getConfiguration } from '../../utils/index.js'

export class Purgatory {
  private bannedAccounts: Array<PurgatoryAccounts>
  private bannedAssets: Array<PurgatoryAssets>
  private accountPurgatoryUrl: string
  private assetPurgatoryUrl: string
  // eslint-disable-next-line no-use-before-define
  private static instance: Purgatory

  private enabled: boolean = false

  constructor(accountPurgatoryUrl: string, assetPurgatoryUrl: string) {
    this.accountPurgatoryUrl = accountPurgatoryUrl
    this.assetPurgatoryUrl = assetPurgatoryUrl
    this.bannedAccounts = []
    this.bannedAssets = []
    this.enabled = this.isAccountsPurgatoryEnabled() || this.isAssetsPurgatoryEnabled()
  }

  getBannedAccounts(): Array<PurgatoryAccounts> {
    return this.bannedAccounts
  }

  getBannedAssets(): Array<PurgatoryAssets> {
    return this.bannedAssets
  }

  setBannedAccounts(newBannedAccounts: Array<PurgatoryAccounts>): void {
    this.bannedAccounts = newBannedAccounts
  }

  setBannedAssets(newBannedAssets: Array<PurgatoryAssets>): void {
    this.bannedAssets = newBannedAssets
  }

  async parsePurgatoryAssets(): Promise<Array<PurgatoryAssets>> {
    const purgatoryAssets: Array<PurgatoryAssets> = []
    if (this.isAssetsPurgatoryEnabled()) {
      try {
        const response = await axios({
          method: 'get',
          url: this.assetPurgatoryUrl,
          timeout: 2000
        })
        if (response.status !== 200) {
          INDEXER_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `PURGATORY: Failure when retrieving new purgatory list from ASSET_PURGATORY_URL env var.
                Response: ${response.data}, status: ${
                  response.status + response.statusText
                }`,
            true
          )
          return purgatoryAssets
        }
        INDEXER_LOGGER.logMessage(
          `PURGATORY: Successfully retrieved new purgatory list from ASSET_PURGATORY_URL env var.`
        )

        for (const asset of response.data) {
          if (asset && 'did' in asset) {
            purgatoryAssets.push({ did: asset.did, reason: asset.reason })
          }
        }
        this.setBannedAssets(purgatoryAssets)
        return purgatoryAssets
      } catch (err) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Error fetching purgatory list for assets: ${err}`,
          true
        )
      }
    }

    return purgatoryAssets
  }

  async parsePurgatoryAccounts(): Promise<Array<PurgatoryAccounts>> {
    const purgatoryAccounts: Array<PurgatoryAccounts> = []
    if (this.isAccountsPurgatoryEnabled()) {
      try {
        const response = await axios({
          method: 'get',
          url: this.accountPurgatoryUrl,
          timeout: 2000 // small increase
        })
        if (response.status !== 200) {
          INDEXER_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `PURGATORY: Failure when retrieving new purgatory list from ACCOUNT_PURGATORY_URL env var.
              Response: ${response.data}, status: ${
                response.status + response.statusText
              }`,
            true
          )
          return purgatoryAccounts
        }
        INDEXER_LOGGER.logMessage(
          `PURGATORY: Successfully retrieved new purgatory list from ACCOUNT_PURGATORY_URL env var.`
        )
        for (const account of response.data) {
          if (account && 'address' in account) {
            purgatoryAccounts.push({ address: account.address, reason: account.reason })
          }
        }
        this.setBannedAccounts(purgatoryAccounts)
        return purgatoryAccounts
      } catch (err) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Error fetching purgatory list for accounts: ${err}`,
          true
        )
      }
    }
    return purgatoryAccounts
  }

  async isBannedAccount(refAddress: string): Promise<boolean> {
    let purgatoryAccounts = []
    if (this.getBannedAccounts().length > 0) {
      purgatoryAccounts = this.getBannedAccounts()
    } else {
      purgatoryAccounts = await this.parsePurgatoryAccounts()
    }
    for (const acc of purgatoryAccounts) {
      if (acc.address?.toLowerCase() === refAddress?.toLowerCase()) {
        return true
      }
    }
    return false
  }

  async isBannedAsset(refDid: string): Promise<boolean> {
    let purgatoryAssets = []
    if (this.getBannedAssets().length > 0) {
      purgatoryAssets = this.getBannedAssets()
    } else {
      purgatoryAssets = await this.parsePurgatoryAssets()
    }
    for (const asset of purgatoryAssets) {
      if (asset.did === refDid) {
        return true
      }
    }
    return false
  }

  private isAssetsPurgatoryEnabled(): boolean {
    return URLUtils.isValidUrl(this.assetPurgatoryUrl)
  }

  private isAccountsPurgatoryEnabled(): boolean {
    return URLUtils.isValidUrl(this.accountPurgatoryUrl)
  }

  isEnabled(): boolean {
    return this.enabled
  }

  static async getInstance(): Promise<Purgatory> {
    if (!Purgatory.instance) {
      const config = await getConfiguration()
      Purgatory.instance = new Purgatory(
        config.accountPurgatoryUrl,
        config.assetPurgatoryUrl
      )
    }
    return Purgatory.instance
  }
}
