import { expect, assert } from 'chai'
import { sleep, getEventFromTx } from '../../utils/util.js'
import { URLUtils } from '../../utils/url.js'
import { validateConsumerParameters } from '../../utils/validators.js'
import { ConsumerParameter } from '../../@types/DDO/ConsumerParameter.js'

describe('Utilities Functions', () => {
  describe('sleep function', () => {
    it('should resolve after specified time', async () => {
      const startTime = new Date().getTime()
      await sleep(1000) // sleep for 1 second
      const endTime = new Date().getTime()
      expect(endTime - startTime).to.be.at.least(999) // sometimes there is a milisecond dif locally
    })

    it('should handle/validate multiple URLS', () => {
      assert.isTrue(URLUtils.isValidUrl('https://localhost:80'))
      assert.isFalse(URLUtils.isValidUrl(''))
      assert.isTrue(
        URLUtils.isValidUrl(
          'https://raw.githubusercontent.com/oceanprotocol/list-purgatory/main/list-assets.json'
        )
      )
      assert.isTrue(
        URLUtils.isValidUrl(
          'https://raw.githubusercontent.com/oceanprotocol/list-purgatory/main/list-accounts.json'
        )
      )
      assert.isFalse(URLUtils.isValidUrl('http://hello world!'))
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

  it('should validateConsumerParameters', async () => {
    const ddoConsumerParameters: ConsumerParameter[] = [
      {
        name: 'hometown',
        type: 'text',
        label: 'Hometown',
        required: true,
        description: 'What is your hometown?',
        default: 'Nowhere'
      },
      {
        name: 'age',
        type: 'number',
        label: 'Age',
        required: false,
        description: 'Please fill your age',
        default: 0
      },
      {
        name: 'developer',
        type: 'boolean',
        label: 'Developer',
        required: false,
        description: 'Are you a developer?',
        default: false
      },
      {
        name: 'languagePreference',
        type: 'select',
        label: 'Language',
        required: false,
        description: 'Do you like NodeJs or Python',
        default: 'nodejs',
        options: [
          {
            nodejs: 'I love NodeJs'
          },
          {
            python: 'I love Python'
          }
        ]
      }
    ]
    const userSentObject: any[] = [
      {
        hometown: 'Tokyo',
        age: 12,
        developer: true,
        languagePreference: 'python'
      },
      {
        hometown: 'Kyoto',
        age: 34,
        developer: true,
        languagePreference: 'nodejs'
      },
      {
        hometown: 'Osaka',
        age: 56,
        developer: true,
        languagePreference: 'python'
      },
      {
        hometown: 'Yokohama',
        age: 78,
        developer: false
      },
      {
        hometown: 'Sapporo',
        age: 90,
        developer: false
      }
    ]
    const result = await validateConsumerParameters(ddoConsumerParameters, userSentObject)
    expect(result.valid).to.equal(true)
  })
})
