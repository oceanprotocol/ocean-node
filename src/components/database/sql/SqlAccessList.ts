import type { AccessListUser } from '../../../@types/AccessList.js'
import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import { AbstractAccessListDatabase } from '../BaseDatabase.js'
import type { SqlClient } from './SqlClient.js'
import { SqlDocuments } from './SqlDocuments.js'
import { orNull } from './orNull.js'

// the largest number of access lists that a search by wallet gives
const SEARCH_HITS = 250

// the access list contracts of the indexed chains, each with its users
export class SqlAccessListDatabase extends AbstractAccessListDatabase {
  private lists: SqlDocuments

  constructor(config: OceanNodeDBConfig, db: SqlClient) {
    super(config)
    this.lists = new SqlDocuments(db, 'access_list', config.dbType)
  }

  init(): Promise<void> {
    return this.lists.init()
  }

  // The deployment event. An AddressAdded event can come first and make the list: then
  // only the deployment fields change, and the users stay.
  create(
    chainId: number,
    contractAddress: string,
    transferable: boolean,
    block: number,
    txId: string,
    name?: string,
    symbol?: string
  ) {
    const id = listId(chainId, contractAddress)
    const deployment = { transferable, deploymentBlock: block, deploymentTxId: txId }
    return orNull(`Error when upserting access list ${id}`, async () => {
      await this.lists.modify(id, (list) => ({
        ...(list ?? newList(chainId, contractAddress)),
        ...deployment,
        ...(name != null && { name }),
        ...(symbol != null && { symbol })
      }))
      return { id }
    })
  }

  retrieve(chainId: number, contractAddress: string) {
    const id = listId(chainId, contractAddress)
    return orNull(`Error when retrieving access list ${id}`, () => this.lists.get(id))
  }

  // a token id is in the list one time
  addUser(chainId: number, contractAddress: string, user: AccessListUser) {
    const id = listId(chainId, contractAddress)
    const added: AccessListUser = { ...user, wallet: user.wallet.toLowerCase() }
    const emptyList = { ...newList(chainId, contractAddress), transferable: false }
    return orNull(
      `Error when adding user ${added.wallet} to access list ${id}`,
      async () => {
        await this.lists.modify(id, (current) => {
          const list = current ?? emptyList
          const users: AccessListUser[] = list.users ?? []
          const exists = users.some((existing) => existing.tokenId === added.tokenId)
          return exists ? null : { ...list, users: [...users, added] }
        })
        return { id }
      }
    )
  }

  removeUserByTokenId(chainId: number, contractAddress: string, tokenId: number) {
    const id = listId(chainId, contractAddress)
    return orNull(`Error when removing tokenId ${tokenId} from ${id}`, async () => {
      const list = await this.lists.modify(
        id,
        (current) =>
          current && {
            ...current,
            users: (current.users ?? []).filter(
              (user: AccessListUser) => user.tokenId !== tokenId
            )
          }
      )
      if (!list) {
        DATABASE_LOGGER.error(
          `AddressRemoved on missing access list ${id} (tokenId=${tokenId}); ignoring.`
        )
      }
      return list ? { id } : null
    })
  }

  async searchByWallet(wallet: string, chainId?: number): Promise<any[]> {
    const must: Record<string, any>[] = [{ term: { 'users.wallet': wallet } }]
    if (chainId !== undefined) must.push({ term: { chainId } })
    const lists = await orNull(`Error when searching access lists of ${wallet}`, () =>
      this.lists.search({ query: { bool: { must } } }, SEARCH_HITS, 0)
    )
    return lists ?? []
  }

  delete(chainId: number, contractAddress: string) {
    const id = listId(chainId, contractAddress)
    return orNull(`Error when deleting access list ${id}`, async () =>
      (await this.lists.delete(id)) ? { id } : null
    )
  }
}

function newList(chainId: number, contractAddress: string) {
  return {
    chainId,
    contractAddress: contractAddress.toLowerCase(),
    users: [] as AccessListUser[]
  }
}

function listId(chainId: number, contractAddress: string): string {
  return `${chainId}-${contractAddress.toLowerCase()}`
}
