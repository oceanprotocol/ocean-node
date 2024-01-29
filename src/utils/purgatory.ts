import { Purgatory } from '../components/Indexer/purgatory.js'
import { getDatabase } from './database.js'

export async function getPurgatory(): Promise<Purgatory> {
  return new Purgatory(await getDatabase())
}
