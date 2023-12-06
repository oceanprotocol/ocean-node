export const ddo = {
  hashType: 'sha256',
  '@context': ['https://w3id.org/did/v1'],
  id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d7',
  nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
  version: '4.1.0',
  chainId: 137,
  metadata: {
    created: '2022-12-30T08:40:06Z',
    updated: '2022-12-30T08:40:06Z',
    type: 'dataset',
    name: 'DEX volume in details',
    description:
      'Volume traded and locked of Decentralized Exchanges (Uniswap, Sushiswap, Curve, Balancer, ...), daily in details',
    tags: ['index', 'defi', 'tvl'],
    author: 'DEX',
    license: 'https://market.oceanprotocol.com/terms',
    additionalInformation: {
      termsAndConditions: true
    }
  }
}

export const genericDDO = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  version: '4.1.0',
  chainId: 8996,
  nftAddress: '0x0',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  },
  services: [
    {
      id: 'testFakeId',
      type: 'access',
      description: 'Download service',
      files: '',
      datatokenAddress: '0x0',
      serviceEndpoint: 'http://172.15.0.4:8030',
      timeout: 0
    }
  ]
}
