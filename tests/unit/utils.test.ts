import { expect, assert } from 'chai'
import { sleep, getEventFromTx } from '../../src/utils/util' // replace './yourModule' with the actual path of your module
import 'mocha'

describe('Utilities Functions', () => {
  describe('sleep function', () => {
    it('should resolve after specified time', async () => {
      const startTime = new Date().getTime()
      await sleep(1000) // sleep for 1 second
      const endTime = new Date().getTime()
      expect(endTime - startTime).to.be.at.least(1000)
    })
  })

  describe('getEventFromTx function', () => {
    it('should return the correct event when present in txReceipt', () => {
      const mockEvent = { fragment: { name: 'MockEvent' } }
      const txReceipt = { logs: [mockEvent] }
      const result = getEventFromTx(txReceipt, 'MockEvent')
      expect(result).to.deep.equal(mockEvent)
    })

    it('should return undefined when event is not present in txReceipt', () => {
      const txReceipt = { logs: [{ fragment: { name: 'AnotherEvent' } }] }
      const result = getEventFromTx(txReceipt, 'MockEvent')
      assert.isUndefined(
        result,
        'Result should be undefined for txReceipt with null logs'
      )
    })

    it('should handle undefined or malformed txReceipt', () => {
      let result = getEventFromTx({ logs: [undefined] }, 'MockEvent')
      assert.isUndefined(
        result,
        'Result should be undefined for txReceipt with null logs'
      )

      result = getEventFromTx({ logs: [null] }, 'MockEvent')
      assert.isUndefined(
        result,
        'Result should be undefined for txReceipt with null logs'
      )

      result = getEventFromTx({ logs: [{}] }, 'MockEvent')
      assert.isUndefined(
        result,
        'Result should be undefined for txReceipt with null logs'
      )
    })
  })
})
