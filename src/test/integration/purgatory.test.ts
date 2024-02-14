import { expect, assert } from 'chai'
import { Purgatory } from '../../components/Indexer/purgatory.js'

describe('Purgatory test', async () => {
  let purgatory: Purgatory

  before(async () => {
    purgatory = await Purgatory.getInstance()
  })

  it('instance Purgatory', async () => {
    expect(purgatory).to.be.instanceOf(Purgatory)
  })
  it('should retrieve account list', async () => {
    const accountPurgatory = await purgatory.parsePurgatoryAccounts()
    assert(accountPurgatory, 'account purgatory list could not be fetched.')
    let res: any
    for (const acc of accountPurgatory) {
      if (acc.address === '0xAD23fC9D943018C34aC55E8DA29AF700A2Fd0FeB') {
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
})
