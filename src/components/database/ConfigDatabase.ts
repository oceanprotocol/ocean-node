// Node-wide key/value settings (indexer version, maintenance mode flag).
// Both methods return null on a DB error; retrieveValue returns { value: null } for an absent key.
export interface ConfigDatabase {
  createOrUpdateConfig(
    key: string,
    value: string
  ): Promise<{ key: string; value: string } | null>
  retrieveValue(key: string): Promise<{ value: string | null } | null>
}
