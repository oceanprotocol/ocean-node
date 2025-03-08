import { assert, expect } from 'chai'
import { describe, it } from 'mocha'
import {
  compareVersions,
  isReindexingNeeded
} from '../../../components/Indexer/version.js'

describe('Version utilities', () => {
  describe('compareVersions', () => {
    it('should return 0 for equal versions', () => {
      expect(compareVersions('1.0.0', '1.0.0')).to.equal(0)
      expect(compareVersions('2.3.1', '2.3.1')).to.equal(0)
    })

    it('should return -1 when first version is less than second', () => {
      expect(compareVersions('1.0.0', '1.0.1')).to.equal(-1)
      expect(compareVersions('1.9.9', '2.0.0')).to.equal(-1)
      expect(compareVersions('2.3.0', '2.3.1')).to.equal(-1)
      expect(compareVersions('0.2.1', '0.2.2')).to.equal(-1)
    })

    it('should return 1 when first version is greater than second', () => {
      expect(compareVersions('1.0.1', '1.0.0')).to.equal(1)
      expect(compareVersions('2.0.0', '1.9.9')).to.equal(1)
      expect(compareVersions('2.3.1', '2.3.0')).to.equal(1)
    })

    it('should handle versions with different number of segments', () => {
      expect(compareVersions('1.0', '1.0.0')).to.equal(0)
      expect(compareVersions('1.0.0.0', '1.0.0')).to.equal(0)
      expect(compareVersions('1.0', '1.0.1')).to.equal(-1)
      expect(compareVersions('1.1', '1.0.9')).to.equal(1)
    })
  })

  describe('isReindexingNeeded', () => {
    it('should return true if dbVersion is null', () => {
      assert(isReindexingNeeded('1.0.0', null, '0.9.0') === true)
    })

    it('should return true if dbVersion is less than minVersion', () => {
      assert(isReindexingNeeded('1.0.0', '0.1.0', '0.2.0') === true)
      assert(isReindexingNeeded('0.3.0', '0.2.1', '0.2.2') === true)
    })

    it('should return false if dbVersion is equal to minVersion', () => {
      assert(isReindexingNeeded('1.0.0', '0.2.0', '0.2.0') === false)
    })

    it('should return false if dbVersion is greater than minVersion', () => {
      assert(isReindexingNeeded('1.0.0', '0.3.0', '0.2.0') === false)
    })

    it('should throw error if currentVersion is less than minVersion', () => {
      expect(() => isReindexingNeeded('0.1.0', '0.2.0', '0.2.0')).to.throw(
        'Current version 0.1.0 is less than minimum required version 0.2.0'
      )
    })
  })
})
