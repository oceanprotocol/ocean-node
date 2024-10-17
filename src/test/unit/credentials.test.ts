import { expect } from 'chai'
import { checkCredentials } from '../../utils/credentials.js'
import { Credentials } from '../../@types/DDO/Credentials.js'

describe('credentials', () => {
  it('should allow access with undefined or empty credentials', () => {
    const credentialsUndefined: Credentials = undefined
    const consumerAddress = '0x123'
    const accessGranted1 = checkCredentials(credentialsUndefined, consumerAddress)
    expect(accessGranted1).to.equal(true)
    const credentialsEmapty = {} as Credentials
    const accessGranted2 = checkCredentials(credentialsEmapty, consumerAddress)
    expect(accessGranted2).to.equal(true)
  })
  it('should allow access with empty allow and deny lists', () => {
    const credentials: Credentials = {
      allow: [],
      deny: []
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should allow access with empty values in deny lists', () => {
    const credentials: Credentials = {
      deny: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should deny access with empty values in allow lists', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })
  it('should allow access with address in allow list', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: ['0x123']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should allow access with address not in deny list', () => {
    const credentials: Credentials = {
      deny: [
        {
          type: 'address',
          values: ['0x456']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should deny access with address in deny list', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: []
        }
      ],
      deny: [
        {
          type: 'address',
          values: ['0x123']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })
  it('should deny access with address not in allow list', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: ['0x456']
        }
      ],
      deny: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })
})
