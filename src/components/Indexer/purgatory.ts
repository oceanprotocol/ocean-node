import { PurgatoryAccounts, PurgatoryAssets } from '../../@types/Purgatory.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { errorSummary } from '../../utils/logging/redact.js'
import { URLUtils } from '../../utils/url.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

// the lists are re-fetched on every metadata event while empty, so failures are throttled
const ASSETS_THROTTLE_KEY = 'purgatory-assets'
const ACCOUNTS_THROTTLE_KEY = 'purgatory-accounts'

export class Purgatory {
  private bannedAccounts: Array<PurgatoryAccounts>
  private bannedAssets: Array<PurgatoryAssets>
  private accountPurgatoryUrl: string
  private assetPurgatoryUrl: string
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
        const response = await fetch(this.assetPurgatoryUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(2000)
        })
        if (response.status !== 200) {
          INDEXER_LOGGER.throttled(
            ASSETS_THROTTLE_KEY,
            LOG_LEVELS_STR.LEVEL_WARN,
            `Failed to fetch asset purgatory list (ASSET_PURGATORY_URL): ${response.status} ${response.statusText}`
          )
          return purgatoryAssets
        }
        INDEXER_LOGGER.resetThrottle(ASSETS_THROTTLE_KEY)
        INDEXER_LOGGER.debug(
          `Purgatory: retrieved new purgatory list from ASSET_PURGATORY_URL`
        )

        const assets = await response.json()
        for (const asset of assets) {
          if (asset && 'did' in asset) {
            purgatoryAssets.push({ did: asset.did, reason: asset.reason })
          }
        }
        this.setBannedAssets(purgatoryAssets)
        return purgatoryAssets
      } catch (err) {
        INDEXER_LOGGER.throttled(
          ASSETS_THROTTLE_KEY,
          LOG_LEVELS_STR.LEVEL_WARN,
          `Error fetching purgatory list for assets: ${errorSummary(err)}`
        )
      }
    }

    return purgatoryAssets
  }

  async parsePurgatoryAccounts(): Promise<Array<PurgatoryAccounts>> {
    const purgatoryAccounts: Array<PurgatoryAccounts> = []
    if (this.isAccountsPurgatoryEnabled()) {
      try {
        const response = await fetch(this.accountPurgatoryUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(2000) // small increase
        })
        if (response.status !== 200) {
          INDEXER_LOGGER.throttled(
            ACCOUNTS_THROTTLE_KEY,
            LOG_LEVELS_STR.LEVEL_WARN,
            `Failed to fetch account purgatory list (ACCOUNT_PURGATORY_URL): ${response.status} ${response.statusText}`
          )
          return purgatoryAccounts
        }
        INDEXER_LOGGER.resetThrottle(ACCOUNTS_THROTTLE_KEY)
        INDEXER_LOGGER.debug(
          `Purgatory: retrieved new purgatory list from ACCOUNT_PURGATORY_URL`
        )
        const accounts = await response.json()
        for (const account of accounts) {
          if (account && 'address' in account) {
            purgatoryAccounts.push({ address: account.address, reason: account.reason })
          }
        }
        this.setBannedAccounts(purgatoryAccounts)
        return purgatoryAccounts
      } catch (err) {
        INDEXER_LOGGER.throttled(
          ACCOUNTS_THROTTLE_KEY,
          LOG_LEVELS_STR.LEVEL_WARN,
          `Error fetching purgatory list for accounts: ${errorSummary(err)}`
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

  static getInstance(config: OceanNodeConfig): Purgatory {
    if (!Purgatory.instance) {
      Purgatory.instance = new Purgatory(
        config.accountPurgatoryUrl,
        config.assetPurgatoryUrl
      )
    }
    return Purgatory.instance
  }
}
