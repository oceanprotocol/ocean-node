import { expect, assert } from 'chai'
import { Purgatory } from '../../components/Indexer/purgatory.js'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/index.js'

describe('Purgatory test', () => {
  let purgatory: Purgatory
  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    // override and save configuration (always before calling getConfig())
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.ASSET_PURGATORY_URL,
          ENVIRONMENT_VARIABLES.ACCOUNT_PURGATORY_URL
        ],
        [
          'https://raw.githubusercontent.com/oceanprotocol/list-purgatory/main/list-assets.json',
          'https://raw.githubusercontent.com/oceanprotocol/list-purgatory/main/list-accounts.json'
        ]
      )
    )

    purgatory = await Purgatory.getInstance()
  })

  it('instance Purgatory', () => {
    expect(purgatory).to.be.instanceOf(Purgatory)
  })
  it('should retrieve account list', async () => {
    const accountPurgatory = await purgatory.parsePurgatoryAccounts()
    assert(accountPurgatory, 'account purgatory list could not be fetched.')
    let res: any
    for (const acc of accountPurgatory) {
      if (
        acc.address?.toLowerCase() ===
        '0xAD23fC9D943018C34aC55E8DA29AF700A2Fd0FeB'?.toLowerCase()
      ) {
        res = acc
        break
      }
    }
    assert(res, 'could not find this banned account')
    assert(res.reason === 'bad actor')
  })

  it('should check if account is banned', async () => {
    assert(
      (await purgatory.isBannedAccount('0xAD23fC9D943018C34aC55E8DA29AF700A2Fd0FeB')) ===
        true
    )
  })

  it('should retrieve assets list', async () => {
    const assetPurgatory = await purgatory.parsePurgatoryAssets()
    assert(assetPurgatory, 'asset purgatory list could not be fetched.')
    let res: any
    for (const a of assetPurgatory) {
      if (
        a.did ===
        'did:op:5b33dd722bd9e5e291685545203dfcfd914b55d12de0c1f31541d323e581041c'
      ) {
        res = a
        break
      }
    }
    assert(res, 'could not find this banned asset')
    assert(res.reason === 'mumbai test dataset')
  })

  it('should check if asset is banned', async () => {
    assert(
      (await purgatory.isBannedAsset(
        'did:op:5b33dd722bd9e5e291685545203dfcfd914b55d12de0c1f31541d323e581041c'
      )) === true
    )
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
