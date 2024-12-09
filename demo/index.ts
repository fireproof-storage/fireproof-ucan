import * as Agent from '@web3-storage/access/agent';
import * as CAR from '@ucanto/transport/car';
import * as CBOR from '@ipld/dag-cbor';
import * as DidMailto from '@web3-storage/did-mailto';
import * as HTTP from '@ucanto/transport/http';
import * as Block from 'multiformats/block';
import * as W3 from '@web3-storage/w3up-client';
import { Absentee } from '@ucanto/principal';
import { ParsedArgs } from 'minimist';
import { connect } from '@ucanto/client';
import { DID, parseLink } from '@ucanto/core';
import { sha256 } from 'multiformats/hashes/sha2';
import minimist from 'minimist';

import * as ClockCapabilities from '../src/capabilities/clock';
import * as StoreCapabilities from '../src/capabilities/store';
import { Service } from '../src/index';

import * as Client from '../test/common/client';
import { bytesToDelegations } from '@web3-storage/access/encoding';

// PREP

const HOST = new URL('https://fireproof-ucan.jchris.workers.dev');
const server = DID.parse('did:key:z6MkjasueTeWJzkNAF7PAU8bZa8a3ii6uK979QKf7Fogyq8M');

console.log('Server ID', server.did());

const args: ParsedArgs = minimist(process.argv.slice(2));
const email = args.email;
if (!email) throw new Error('`email` flag is required');

const persona = Absentee.from({ id: DidMailto.fromEmail(email) });
const connection = Agent.connection<`did:key:${string}`, Service>({
	principal: server,
	url: HOST,
});

const service = connect<any>({
	id: server,
	codec: CAR.outbound,
	channel: HTTP.open({
		url: HOST,
		method: 'POST',
	}),
});

const w3 = await W3.create({
	serviceConf: {
		access: service,
		filecoin: service,
		upload: service,
	},
});

// CREATE CLOCK

const clock = await Client.createClock({ audience: persona });
const registration = await Client.registerClock({ clock, connection, server });

console.log('⏰ Clock registration', registration.out);
if (registration.out.error) process.exit(1);

// LOGIN / AUTHORISE USING EMAIL
// NOTE: Could opt for the simpler `@web3-storage/access` package instead using the whole w3up package.
console.log('Waiting for main account to login ...');
const account = await w3.login(email);
console.log('👮 Agent', account.agent.did());
console.log(
	'🤹 Account proofs',
	account.proofs.map((p) => p.capabilities),
);

const attestation = account.proofs.find((p) => p.capabilities[0].can === 'ucan/attest');
const delegation = account.proofs.find((p) => p.capabilities[0].can === '*');

if (!attestation || !delegation) {
	console.error('Unable to locate agent attestion or delegation');
	process.exit(1);
}

const agent: Client.Agent = {
	attestation,
	delegation,
	signer: account.agent.issuer,
};

// CREATE & STORE CLOCK EVENT

const event = await Client.createClockEvent({
	messageCid: parseLink('bagbaierale63ypabqutmxxbz3qg2yzcp2xhz2yairorogfptwdd5n4lsz5xa'),
});

const storeResp = await StoreCapabilities.add
	.invoke({
		issuer: agent.signer,
		audience: server,
		with: agent.signer.did(),
		nb: {
			link: event.cid,
			size: event.bytes.length,
		},
	})
	.execute(connection);

console.log('📦 store/add', storeResp.out);
if (storeResp.out.error) process.exit(1);

const storeUrl = storeResp.out.ok.url;

const r2 = await fetch(storeUrl, {
	method: 'PUT',
	body: event.bytes,
});

console.log('📦 R2 upload, succeeded', r2.ok);

if (!r2.ok) {
	console.error(await r2.text());
	console.error(`Couldn't store event on R2, status: ${r2.status}`);
	process.exit(1);
}

// ADVANCE CLOCK

const advancement = await Client.advanceClock({ agent, clock, connection, event, server });

console.log('⏰ Clock advancement', advancement.out);
if (advancement.out.error) process.exit(1);

// GET CLOCK HEAD

const head = await Client.getClockHead({ agent, clock, connection, server });

console.log('⏰ Clock head', head.out);
if (head.out.error) process.exit(1);

const getResp = await StoreCapabilities.get
	.invoke({
		issuer: agent.signer,
		audience: server,
		with: agent.signer.did(),
		nb: {
			link: event.cid,
		},
	})
	.execute(connection);

if (getResp.out.error) {
	console.error(getResp.out.error);
	process.exit(1);
}

if (getResp.out.ok.data === undefined) {
	console.error('Clock event not found');
	process.exit(1);
}

const block = await Block.decode({
	bytes: getResp.out.ok.data,
	codec: CBOR,
	hasher: sha256,
});

const metadataCid = (block.value as any).data.metadata;

console.log('👀 Event data:', metadataCid);

// SHARE TO BOB

if (!args['share-email']) process.exit(0);
const sharePersona = Absentee.from({ id: DidMailto.fromEmail(args['share-email']) });

const share = await Client.shareClock({
	issuer: persona,
	audience: sharePersona,
	clock: clock.did(),
	genesisClockDelegation: clock.delegation,
});

console.log('🫴 Shared clock to', sharePersona.did());

// BOB CAN VERIFY ALICE USING AN ATTESTATION FROM THE SERVER
// NOTE: See tests for more details about the flow

const w3Bob = await W3.create({
	serviceConf: {
		access: service,
		filecoin: service,
		upload: service,
	},
});

console.log('Waiting for share-receiver account to login ...');
const accountBob = await w3Bob.login(args['share-email']);

const attestationAlice = attestation;
const delegationAlice = delegation;

const attestationBob = accountBob.proofs.find((p) => p.capabilities[0].can === 'ucan/attest');
const delegationBob = accountBob.proofs.find((p) => p.capabilities[0].can === '*');

if (!attestationBob || !delegationBob) {
	console.error('Unable to locate agent attestion or delegation');
	process.exit(1);
}

const agentBob = {
	attestation: attestationBob,
	delegation: delegationBob,
	signer: accountBob.agent.issuer,
};

const aliceIsVerifiedOffline = (() => {
	// @ts-ignore
	const proof = attestationAlice.capabilities[0].nb?.proof;

	return (
		attestationAlice.issuer.did() === attestationBob.issuer.did() &&
		delegationAlice.link().toString() === proof.toString() &&
		share.delegation.issuer.did() === delegationAlice.issuer.did()
	);
})();

console.log('Offline verification of Alice, verified:', aliceIsVerifiedOffline);

// SHARER CAN USE CLOCK ABILITIES ON THE SERVER

// (1) ALICE HAS TO AUTHORIZE/CONFIRM THE SHARE

const authorizeShareResp = await ClockCapabilities.authorizeShare
	.invoke({
		issuer: agent.signer,
		audience: server,
		with: agent.signer.did(),
		nb: {
			issuer: persona.did(),
			recipient: sharePersona.did(),
			proof: share.delegation.cid,
		},
		proofs: [share.delegation],
	})
	.execute(connection);

console.log('🫴 Share authorization', authorizeShareResp.out);
if (authorizeShareResp.out.error) process.exit(1);

// (2) WAIT UNTIL SHARER CONFIRMS SHARE

const claim = async () => {
	const resp = await ClockCapabilities.claimShare
		.invoke({
			issuer: accountBob.agent.issuer,
			audience: server,
			with: agentBob.signer.did(),
			nb: {
				recipient: sharePersona.did(), // Receiver
				proof: share.delegation.cid,
			},
			proofs: [agentBob.attestation, agentBob.delegation],
		})
		.execute(connection);

	console.log(resp.out);
	if (resp.out.error) throw resp.out.error;

	return Object.values(resp.out.ok.delegations).flatMap((proof) => bytesToDelegations(proof));
};

const poll = async () => {
	const proofs = await claim();

	const attestation = proofs.find((p) => p.capabilities[0].can === 'ucan/attest');

	if (!attestation) {
		await new Promise((resolve) => {
			setTimeout(resolve, 2500);
		});

		return await poll();
	}

	return attestation;
};

console.log('Waiting for share confirmation ...');
const shareConfirmation = await poll();
console.log('✅ Share confirmed', shareConfirmation);

// (3) USE CLOCK ABILITY

const headBob = await Client.getClockHead({ agent: agentBob, clock, connection, server });

console.log('⏰ Clock head (Bob)', headBob.out);
if (headBob.out.error) process.exit(1);
