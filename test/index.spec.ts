import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import { Agent } from '@web3-storage/access/agent';
import { Store } from '@web3-storage/capabilities';
import { Signer } from '@ucanto/principal/ed25519';
import { parseLink } from '@ucanto/core';
import { base64pad } from 'multiformats/bases/base64';

import { create as createConnection } from './common/connection';
import { addToStore, storeOnServer } from './common/store';

////////////////////////////////////////
// SETUP
////////////////////////////////////////

/** did:key:z6Mkqa4oY9Z5Pf5tUcjLHLUsDjKwMC95HGXdE1j22jkbhz6r */
export const alice = Signer.parse('MgCZT5vOnYZoVAeyjnzuJIVY9J4LNtJ+f8Js0cTPuKUpFne0BVEDJjEu6quFIU8yp91/TY/+MYK8GvlKoTDnqOCovCVM=');
const carLink = parseLink('bagbaierale63ypabqutmxxbz3qg2yzcp2xhz2yairorogfptwdd5n4lsz5xa');

////////////////////////////////////////
// TESTS
////////////////////////////////////////

describe('The Fireproof UCAN service', () => {
	it('should be able to store/add and get back a signed upload URL', async () => {
		const serverId = Signer.parse(env.FIREPROOF_SERVICE_PRIVATE_KEY);

		const response = await addToStore({
			issuer: serverId,
			audience: serverId,
			with: serverId.did(),
			nb: {
				link: carLink,
				size: 0,
			},
		});

		if (response.out.error) {
			throw response.out.error;
		}

		expect(response.out.ok).toBeTruthy();
		expect(response.out.ok.link.toString()).toEqual(carLink.toString());

		// the URL should use https
		expect(response.out.ok.url).match(/^https:\/\/.*$/);

		// the URL should contain the CID
		expect(response.out.ok.url).match(new RegExp(carLink.toString()));
	});

	/**
	 * An invocation issuer doesn't necessarily have to be the server itself.
	 * It just means that the server is the only one allow to invoke a
	 * capability on its own (ie. without any proof)
	 */
	it('cannot invoke a capability without a proof unless invoked by the server itself', async () => {
		const serverId = Signer.parse(env.FIREPROOF_SERVICE_PRIVATE_KEY);
		const issuerId = await Signer.generate();

		const response = await addToStore({
			issuer: issuerId,
			audience: serverId,
			with: serverId.did(),
			nb: {
				link: carLink,
				size: 0,
			},
		});

		expect(response.out.error).toBeTruthy();
	});

	it('should succeed when using an authorized agent', async () => {
		const serverSigner = Signer.parse(env.FIREPROOF_SERVICE_PRIVATE_KEY);
		const connection = createConnection();
		const serverAgent = await Agent.create({ principal: serverSigner }, { connection, servicePrincipal: serverSigner });
		const clientAgent = await Agent.create({}, { connection, servicePrincipal: serverSigner });

		const space = await serverAgent.createSpace('test space');
		const authorization = await space.createAuthorization(clientAgent, {
			access: {
				'store/add': {},
				'store/get': {},
			},
		});

		await clientAgent.importSpaceFromDelegation(authorization);

		const result = await clientAgent.invokeAndExecute(Store.add, {
			nb: {
				link: carLink,
				size: 0,
			},
		});

		if (result.out.error) throw result.out.error;
		expect(result.out.ok).toBeTruthy();

		await storeOnServer(carLink, new Uint8Array([5, 6, 7, 8]));

		const getResult = await clientAgent.invokeAndExecute(Store.get, {
			nb: {
				link: carLink,
			},
		});

		if (getResult.out.error) throw getResult.out.error;
		expect(getResult.out.ok.data && base64pad.encode(getResult.out.ok.data)).toEqual(base64pad.encode(new Uint8Array([5, 6, 7, 8])));
	});
});
