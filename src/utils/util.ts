// Put some utilities functions here
// sleep for ms miliseconds
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getEventFromTx(txReceipt: { logs: any[] }, eventName: any) {
  return txReceipt?.logs?.filter((log) => {
    console.log(' LOG ==> ', log?.fragment?.name)
    return log?.fragment?.name === eventName
  })[0]
}
