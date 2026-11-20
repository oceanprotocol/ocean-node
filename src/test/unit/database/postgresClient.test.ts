import { expect } from 'chai'
import {
  connectionString,
  numberPlaceholders
} from '../../../components/database/sql/PostgresClient.js'

describe('PostgresClient', () => {
  describe('numberPlaceholders', () => {
    it('numbers the placeholders in their order', () => {
      expect(
        numberPlaceholders('SELECT * FROM t WHERE "a" = ? AND "b" IN (?, ?)')
      ).to.equal('SELECT * FROM t WHERE "a" = $1 AND "b" IN ($2, $3)')
    })

    it('keeps a question mark that is in a text or in a name', () => {
      expect(
        numberPlaceholders(`SELECT '?', 'it''s ?', "why?" FROM t WHERE "a" = ?`)
      ).to.equal(`SELECT '?', 'it''s ?', "why?" FROM t WHERE "a" = $1`)
    })
  })

  describe('connectionString', () => {
    const config = (username: string, password: string) =>
      ({
        dbType: 'postgresql',
        url: 'postgresql://db:5432/ocean',
        username,
        password
      }) as const

    it('puts the user and the password into the URL', () => {
      expect(connectionString(config('ocean', 'secret'))).to.equal(
        'postgresql://ocean:secret@db:5432/ocean'
      )
    })

    it('gives back the same password after the decoding that pg does', () => {
      for (const password of ['ab%41cd', 'p@ss:w/rd#1?', 'ünï côde', '100%']) {
        const url = new URL(connectionString(config('ocean', password)))
        expect(decodeURIComponent(url.password)).to.equal(password)
      }
    })
  })
})
