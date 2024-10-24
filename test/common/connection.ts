import { env, SELF } from 'cloudflare:test';

import { connection } from '@web3-storage/access/agent';
import { Signer } from '@ucanto/principal/ed25519';

import { IncomingRequest } from './request';
import { Service } from '../../src/index';

/**
 * Create a W3S access connection.
 */
export function create() {
	return connection<`did:key:${string}`, Service>({
		principal: Signer.parse(env.FIREPROOF_SERVICE_PRIVATE_KEY),
		// @ts-ignore this error is coming from a possible mismatch between the node fetch response type and the cloudflare
		fetch: (url, options) => {
			// @ts-ignore I think this is just an articact of the funky typing we're doing here
			return SELF.fetch(new IncomingRequest(url, options));
		},
	});
}

export const conn = create();
