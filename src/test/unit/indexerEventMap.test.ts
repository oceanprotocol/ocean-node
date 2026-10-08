import { expect } from 'chai'
import { ethers } from 'ethers'
import { EVENT_PROCESSOR_MAP } from '../../components/Indexer/processor.js'
import { EscrowEventProcessor } from '../../components/Indexer/processors/EscrowEventProcessor.js'
import { ESCROW_EVENTS, EVENTS, EVENT_HASHES } from '../../utils/constants.js'

// Regression guard: the indexer dispatches a decoded log by its event-type string through
// EVENT_PROCESSOR_MAP, and getEventProcessor throws "No processor found for event type: X" when a
// type is missing. It is easy to add an event to the decoder / ESCROW_EVENTS / topic0 map but
// forget this dispatch map (exactly what happened for LockSponsored / SponsorRefunded), which makes
// the new decode branches dead code and can break indexing of the block that emits them.
describe('Indexer EVENT_PROCESSOR_MAP wiring', () => {
  it('every ESCROW_EVENTS type resolves to a processor', () => {
    for (const eventType of ESCROW_EVENTS) {
      expect(
        EVENT_PROCESSOR_MAP[eventType],
        `missing EVENT_PROCESSOR_MAP entry for escrow event "${eventType}"`
      ).to.not.equal(undefined)
    }
  })

  it('maps the Escrow v2 lock-time sponsorship events to the EscrowEventProcessor', () => {
    expect(EVENT_PROCESSOR_MAP[EVENTS.ESCROW_LOCK_SPONSORED]).to.equal(
      EscrowEventProcessor
    )
    expect(EVENT_PROCESSOR_MAP[EVENTS.ESCROW_SPONSOR_REFUNDED]).to.equal(
      EscrowEventProcessor
    )
  })

  // Guard against a hand-edited topic0 key or signature text drifting apart: for every escrow
  // entry in EVENT_HASHES, keccak256(signature text) must equal the map key. This is what the
  // indexer matches logs against, so a typo silently stops indexing that event.
  it('each escrow EVENT_HASHES key is keccak256 of its signature text', () => {
    const escrowTypes = new Set<string>(ESCROW_EVENTS)
    const checked: string[] = []
    for (const [topic0, entry] of Object.entries(EVENT_HASHES)) {
      if (!escrowTypes.has(entry.type)) continue
      expect(
        ethers.id(entry.text),
        `topic0 mismatch for ${entry.type} (${entry.text})`
      ).to.equal(topic0)
      checked.push(entry.type)
    }
    // all escrow event types must be present in the topic0 map
    for (const t of ESCROW_EVENTS) {
      expect(checked, `missing EVENT_HASHES entry for escrow event "${t}"`).to.include(t)
    }
  })
})
