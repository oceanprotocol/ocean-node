// Put some utilities functions here
// sleep for ms miliseconds
import {Readable} from "stream";

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function streamToString(stream: Readable) {
  const chunks = []
  for await (let chunk of stream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString()
}
