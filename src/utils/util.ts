// Put some utilities functions here
// sleep for ms miliseconds
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
