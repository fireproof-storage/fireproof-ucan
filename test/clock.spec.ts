import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import * as DidMailto from '@web3-storage/did-mailto';
import * as UCAN from '@web3-storage/capabilities/ucan';
import * as UCANTO from '@ucanto/server';
import * as Json from '@ipld/dag-json';

import { Block } from 'multiformats/block';
import { CID } from 'multiformats';
import { Absentee, ed25519 } from '@ucanto/principal';
import { Signer } from '@ucanto/principal/ed25519';
import { parseLink } from '@ucanto/core';
import { sha256 } from 'multiformats/hashes/sha2';

import * as Clock from '../src/capabilities/clock';
import { create as createDelegationStore } from '../src/stores/delegations/persistent.js';

import * as Connection from './common/connection';
import { addToStore } from './common/store';

describe('Merkle clocks', () => {
	it('can be created, advanced and shared', async () => {
		const clock = await ed25519.Signer.generate();
		const alice = Absentee.from({ id: DidMailto.fromEmail('alice@example.com') });
		const agent = await ed25519.Signer.generate();
		const server = Signer.parse(env.FIREPROOF_SERVICE_PRIVATE_KEY);

		console.log('✨ CLOCK', clock.did());
		console.log('✨ ALICE', alice.did());
		console.log('✨ AGENT', agent.did());

		// {client} The clock belongs to Alice,
		// delegate the capability to them.
		const delegation = await Clock.advance.delegate({
			issuer: clock,
			audience: alice,
			with: clock.did(),
			expiration: Infinity,
		});

		// With the above clock delegation we could go a few ways:
		// (1) We keep the delegation around on peer(s).
		//     Every time we want to advance the clock on the server,
		//     we make another `emailDelegation` like below and add the delegation to the proofs.
		// (2) We store the delegation on the server,
		//     that way we can always login with email from anywhere
		//     because the server has all the delegations we need and
		//     we don't need to get it from another peer.
		const delegationStore = createDelegationStore(env.bucket, env.kv_store);
		await delegationStore.putMany([delegation]);

		// {client} or {server} Delegate clock and store capabilities to the agent.
		// https://github.com/storacha-network/w3up/blob/fb8b8677c4c633cdf8c259db55357a1794eed3ab/packages/w3up-client/test/helpers/utils.js#L14
		// NOTE: Ideally this and the following attestation step is done through the "login" flow.
		const emailDelegation = await UCANTO.delegate({
			issuer: alice,
			audience: agent,
			capabilities: [{ can: '*', with: 'ucan:*' }],
			expiration: Infinity,
			// proofs: await delegationStore.find({ audience: alice.did() }).then((a) => a.ok),
		});

		// {server} Create an attestation to accompany the above delegation which has an attestion signature.
		// More info: https://github.com/storacha-network/specs/blob/54407171c7c2b3bb0151a9cff47e453e4419531e/w3-account.md#attestation-signature
		const emailAttestation = await UCAN.attest.delegate({
			issuer: server,
			audience: agent,
			with: server.did(),
			nb: { proof: emailDelegation.cid },
			expiration: Infinity,
		});

		// {client} Create clock event
		const metadataLink = parseLink('bagbaierale63ypabqutmxxbz3qg2yzcp2xhz2yairorogfptwdd5n4lsz5xa');
		const eventData = { metadata: metadataLink };
		const event = { parents: [], data: eventData };
		const eventBytes = Json.encode(event);
		const eventLink = CID.create(1, Json.code, await sha256.digest(eventBytes));

		// {client} Store event on the server
		const eventCar = await UCANTO.CAR.write({
			roots: [new Block({ cid: eventLink, bytes: eventBytes, value: event })],
		});

		const storeRes = await addToStore({
			issuer: agent,
			audience: server,
			with: agent.did(),
			nb: {
				link: eventCar.cid,
				size: eventCar.bytes.length,
			},
		});

		const storeUrl = storeRes.out.ok?.url;
		if (!storeUrl) throw storeRes.out.error;

		// {client}
		// NOTE: Should do the following on the client I believe, but can't get it to work in test.
		//       Instead writing to the bucket directly as the server.
		// await fetch(storeUrl, { method: 'PUT', body: eventCar.bytes });

		// {server}
		await env.bucket.put(eventCar.cid.toString(), eventCar.bytes);

		// {client} Create an invocation to actually advance the clock.
		// Note the proofs, must have the attestation and its related delegation.
		const invocation = Clock.advance.invoke({
			issuer: agent,
			audience: server,
			with: clock.did(),
			nb: { event: eventCar.cid },
			proofs: [emailAttestation, emailDelegation, delegation],
		});

		// {client} Send the invocation
		const conn = Connection.create();
		const res = await invocation.execute(conn);

		// Expectations
		console.error(res.out.error?.message);
		expect(res.out.error).toBeUndefined();
		expect(res.out.ok?.head).toBe(eventCar.cid.toString());

		// TODO
		return;

		// Share clock abilities to Bob
		const bob = Absentee.from({ id: DidMailto.fromEmail('bob@example.com') });
		const bobAgent = await ed25519.Signer.generate();

		// {client} or {server} Delegate clock abilities to Bob
		const aliceDelegation = await Clock.advance.delegate({
			issuer: alice,
			audience: bob,
			with: clock.did(),
			proofs: [delegation],
			expiration: Infinity,
		});

		// The server has to acknowledge the existence of Alice
		// (Alice gets email to confirm share to Bob)
		const aliceAttestation = await UCAN.attest.delegate({
			issuer: server,
			audience: bob,
			with: server.did(),
			nb: { proof: aliceDelegation.cid },
			expiration: Infinity,
		});

		// {client} or {server} Bob → Bob's agent delegation (Bob logs in)
		const bobEmailDelegation = await UCANTO.delegate({
			issuer: bob,
			audience: bobAgent,
			capabilities: [{ can: '*', with: 'ucan:*' }],
			expiration: Infinity,
			proofs: [aliceDelegation, aliceAttestation],
		});

		// {server}
		const bobEmailAttestation = await UCAN.attest.delegate({
			issuer: server,
			audience: bobAgent,
			with: server.did(),
			nb: { proof: bobEmailDelegation.cid },
			expiration: Infinity,
		});

		// {client} Bob advances the clock
		const bobInvocation = Clock.advance.invoke({
			issuer: bobAgent,
			audience: server,
			with: clock.did(),
			nb: { event: eventCar.cid },
			proofs: [bobEmailAttestation, bobEmailDelegation],
		});

		const bobRes = await bobInvocation.execute(conn);
		if (bobRes.out.error) console.log(bobRes.out.error.message);
		expect(bobRes.out.error).toBeUndefined();
		expect(bobRes.out.ok?.head).toBe(eventCar.cid.toString());
	});
});
