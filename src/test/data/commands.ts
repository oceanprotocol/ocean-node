export const freeComputeStartPayload = {
  command: 'freeStartCompute',
  consumerAddress: '0xeB5ae11175008E8f178d57d0152678a863FbB887',
  environment: '',
  nonce: '1',
  signature: '0x123',
  datasets: [
    {
      fileObject: {
        type: 'url',
        url: 'https://raw.githubusercontent.com/oceanprotocol/ocean-cli/refs/heads/main/metadata/simpleComputeDataset.json',
        method: 'GET'
      }
    }
  ],
  algorithm: {
    fileObject: {
      type: 'url',
      url: 'https://raw.githubusercontent.com/oceanprotocol/ocean-cli/refs/heads/main/metadata/pythonAlgo.json',
      method: 'GET'
    },
    meta: {
      container: {
        image: 'my-compute-test',
        tag: 'latest',
        entrypoint: 'python $ALGO',
        checksum: 'my-compute-checksum'
      }
    }
  }
}
