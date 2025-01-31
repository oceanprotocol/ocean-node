export const freeComputeStartPayload = {
  command: 'freeStartCompute',
  consumerAddress: '0xC7EC1970B09224B317c52d92f37F5e1E4fF6B687',
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
