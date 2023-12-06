import { Database } from '../../src/components/database'
import { sleep } from '../../src/utils/util'

export const delay = (interval: number) => {
  return it('should delay', (done) => {
    setTimeout(() => done(), interval)
  }).timeout(interval + 100)
}

export const waitToIndex = async (did: string, database: Database): Promise<any> => {
  let tries = 0
  do {
    try {
      const ddo = await database.ddo.retrieve(did)
      if (ddo) {
        return ddo
      }
    } catch (e) {
      // do nothing
    }
    sleep(1500)
    tries++
  } while (tries < 100)
  return null
}
