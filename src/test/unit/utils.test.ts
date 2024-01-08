import { expect, assert } from 'chai'
import { sleep, getEventFromTx } from '../../utils/util.js' // replace './yourModule' with the actual path of your module
import 'mocha'

describe('Utilities Functions', () => {
  describe('sleep function', () => {
    it('should resolve after specified time', async () => {
      const startTime = new Date().getTime()
      await sleep(1000) // sleep for 1 second
      const endTime = new Date().getTime()
      expect(endTime - startTime).to.be.at.least(999) // sometimes there is a milisecond dif locally
    })
  })

  describe('getEventFromTx function', () => {
    // Mock event for OrderStarted
    const mockOrderStartedEvent = {
      fragment: { name: 'OrderStarted' },
      data: {
        consumer: '0xConsumerAddress',
        payer: '0xPayerAddress',
        amount: 1000,
        serviceIndex: 1,
        timestamp: Date.now(),
        publishMarketAddress: '0xMarketAddress',
        blockNumber: 123456
      }
    }

    // Mock event for OrderReused
    const mockOrderReusedEvent = {
      fragment: { name: 'OrderReused' },
      data: {
        orderTxId: '0xOrderTxId',
        caller: '0xCallerAddress',
        timestamp: Date.now(),
        number: 2
      }
    }

    // Test for OrderStarted event
    it('should return the OrderStarted event when present in txReceipt', () => {
      const txReceipt = { logs: [mockOrderStartedEvent] }
      const result = getEventFromTx(txReceipt, 'OrderStarted')
      assert.deepEqual(
        result,
        mockOrderStartedEvent,
        'Should return the correct OrderStarted event'
      )
    })

    // Test for OrderReused event
    it('should return the OrderReused event when present in txReceipt', () => {
      const txReceipt = { logs: [mockOrderReusedEvent] }
      const result = getEventFromTx(txReceipt, 'OrderReused')
      assert.deepEqual(
        result,
        mockOrderReusedEvent,
        'Should return the correct OrderReused event'
      )
    })

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
