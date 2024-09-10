import { DID, Link } from '@ucanto/core/schema';
import { capability, Schema } from '@ucanto/server';

export const clock = capability({
	can: 'clock/*',
	with: DID.match({ method: 'key' }),
});

/**
 * Advance the clock by adding an event.
 */
export const advance = capability({
	can: 'clock/advance',
	with: DID.match({ method: 'key' }),
	nb: Schema.struct({
		// CAR file CID containing the event.
		// Data format: https://github.com/storacha-network/specs/blob/e04e53f/w3-clock.md#data-format
		event: Link.match({ version: 1 }),
	}),
});

/**
 * List the CIDs of the events at the head of this clock.
 */
export const head = capability({
	can: 'clock/head',
	with: DID.match({ method: 'key' }),
});

/**
 * Register a clock, storing the genesis delegation.
 */
export const register = capability({
	can: 'clock/register',
	with: DID.match({ method: 'key' }),
	nb: Schema.struct({
		proof: Link.match({ version: 1 }),
	}),
});
