export interface Nft {
  /**
   * Contract address of the deployed ERC721 NFT contract.
   * @type {string}
   */
  address: string

  /**
   * Name of NFT set in contract.
   * @type {string}
   */
  name: string

  /**
   * Symbol of NFT set in contract.
   * @type {string}
   */
  symbol: string

  /**
   * ETH account address of the NFT owner.
   * @type {string}
   */
  owner: string

  /**
   * State of the asset reflecting the NFT contract value.
   * See https://docs.oceanprotocol.com/developers/ddo-specification#state
   * @type {number}
   */
  state: number

  /**
   * Contains the date of NFT creation. ISO date/time string.
   * @type {string}
   */
  created: string

  /**
   * Contains the date of NFT creation.
   * @type {string}
   */
  tokenURI: string
}
