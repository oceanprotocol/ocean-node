import 'jest'
import {Database} from "../../src/components/database";
import {getConfig} from "../../src/utils";

describe('Database', () => {
  let database: Database

  beforeAll(async () => {
    const config = await getConfig()
    database = new Database(config.dbConfig)
  })

  it('instance Typesense', async () => {
    expect(database).toBeInstanceOf(Database)
  })
})
