import * as API from '@web3-storage/upload-api/types';
import * as DidMailto from '@web3-storage/did-mailto';
import * as Block from 'multiformats/block';
import * as CBOR from '@ipld/dag-cbor';
import * as ShaHash from 'multiformats/hashes/sha2';
import * as Server from '@ucanto/server';
import * as Signer from '@ucanto/principal/ed25519';
import * as UCAN from '@web3-storage/capabilities/ucan';
import * as Uint8Arrays from 'uint8arrays';

import fromAsync from 'array-from-async';

import { Message } from '@ucanto/core';
import { KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import { CAR } from '@ucanto/transport';
import { AgentMessage } from '@web3-storage/upload-api';
import { AccessServiceContext, AccessConfirm, ProvisionsStorage } from '@web3-storage/upload-api';
import { createService as createAccessService } from '@web3-storage/upload-api/access';
import { UnavailableProof } from '@ucanto/validator';
import { extract } from '@ucanto/core/delegation';
import { delegationsToBytes, delegationToString, stringToDelegation } from '@web3-storage/access/encoding';
import { AwsClient } from 'aws4fetch';
import { CID } from 'multiformats';
import all from 'it-all';

import type { Env } from '../worker-configuration';
import * as Clock from './capabilities/clock';
import * as Store from './capabilities/store';
import * as Email from './email';

import { create as createAgentStore } from './stores/agents/persistent';
import { create as createDelegationStore } from './stores/delegations/persistent';
import { provideConstructor } from './provide';

////////////////////////////////////////
// TYPES
////////////////////////////////////////

interface Context {
	readonly accessKeyId: string;
	readonly accountId: string;
	readonly bucket: R2Bucket;
	readonly bucketName: string;
	readonly emailAddress?: string;
	readonly kvStore: KVNamespace;
	readonly postmarkToken: string;
	readonly secretAccessKey: string;
	readonly lifetimeInSeconds?: number;
	readonly productURL?: string;
	readonly productName?: string;
	readonly expiresInSeconds?: number;
}

type FireproofServiceContext = AccessServiceContext & Context;

////////////////////////////////////////
// SERVICE
////////////////////////////////////////

export type Service = ReturnType<typeof createService>;

function createService(ctx: FireproofServiceContext) {
	const R2 = new AwsClient({
		accessKeyId: ctx.accessKeyId,
		secretAccessKey: ctx.secretAccessKey,
		region: 'auto',
	});

	const provide = provideConstructor({
		// Provide additional delegations from store
		fromStore: async (audience: `did:key:${string}` | `did:mailto:${string}`) => {
			const result = await ctx.delegationsStorage.find({ audience });
			if (result.ok) return result.ok;
			return [];
		},
	});

	return {
		access: createAccessService(ctx),
		clock: {
			advance: provide(Clock.advance, async ({ capability }) => {
				// Retrieve event and decode it
				const eventBytes = await ctx.bucket.get(capability.nb.event.toString());
				if (!eventBytes) return { error: new Server.Failure('Unable to locate event bytes in store. Was the event stored?') };

				const block = await Block.decode({
					bytes: new Uint8Array(await eventBytes.arrayBuffer()),
					codec: {
						code: CBOR.code,
						decode: CBOR.decode,
					},
					hasher: ShaHash.sha256,
				});

				const event = block.value;

				// Validate event
				if (event === null || typeof event !== 'object') return { error: new Server.Failure('Associated clock event is not an object.') };
				if (!('data' in event)) return { error: new Server.Failure('Associated clock event does not have the `data` property.') };
				if (!('parents' in event)) return { error: new Server.Failure('Associated clock event does not have the `parents` property.') };
				if (!Array.isArray(event.parents)) {
					return { error: new Server.Failure('Associated clock event does not have a valid `parents` property, expected an array.') };
				}

				// Possible TODO: Check if previous head is in event chain?

				// Update head
				await ctx.kvStore.put(`clock/${capability.with}`, capability.nb.event.toString());

				// Fin
				return {
					ok: {
						head: capability.nb.event.toString(),
					},
				};
			}),
			'authorize-share': provide(Clock.authorizeShare, async ({ capability, invocation }) => {
				const accountDID = capability.nb.issuer;
				const email = DidMailto.toEmail(DidMailto.fromString(accountDID));

				if (invocation.proofs[0]?.link().toString() !== capability.nb.proof.toString()) {
					return { error: new Server.Failure('Proof linked in capability does not match proof in invocation') };
				}

				// Store share delegation (account A → account B)
				// This one is useless without an attestation,
				// which we'll acquire through the email flow.
				const delegations = invocation.proofs.filter((proof) => {
					return 'archive' in proof;
				});

				await ctx.delegationsStorage.putMany(delegations, { cause: invocation.link() });

				// Start email flow
				const confirmation = await Clock.confirmShare
					.invoke({
						issuer: ctx.signer,
						audience: ctx.signer,
						with: ctx.signer.did(),
						lifetimeInSeconds: ctx.lifetimeInSeconds || 60 * 60 * 24 * 2, // 2 days
						nb: {
							cause: invocation.cid,
						},
					})
					.delegate();

				const encoded = delegationToString(confirmation);
				const url = `${ctx.url.protocol}//${ctx.url.host}/validate-email?ucan=${encoded}&mode=share`;

				if (ctx.emailAddress)
					await Email.send({
						postmarkToken: ctx.postmarkToken,
						recipient: email,
						sender: ctx.emailAddress,
						template: 'share',
						templateData: {
							product_url: ctx.productURL || 'https://fireproof.storage',
							product_name: ctx.productName || 'Fireproof Storage',
							email: email,
							email_share_recipient: DidMailto.toEmail(DidMailto.fromString(capability.nb.recipient)),
							action_url: url,
						},
					});

				// Store invocation
				const message = await Message.build({
					invocations: [invocation],
				});

				await ctx.agentStore.messages.write({
					data: message,
					source: CAR.request.encode(message),
					index: AgentMessage.index(message),
				});

				return { ok: { url } };
			}),
			'claim-share': provide(Clock.claimShare, async ({ capability }) => {
				const shareLink = capability.nb.proof.toString();

				// Find attestation for the confirmation of the share
				const resA = await ctx.delegationsStorage.find({ audience: capability.nb.recipient });
				if (resA.error) return { error: resA.error };

				const attestation = resA.ok.find((d) => {
					const cap = d.capabilities[0];
					return cap && d.issuer.did() === ctx.signer.did() && cap.can === 'ucan/attest' && (cap.nb as any).proof.toString() === shareLink;
				});

				if (!attestation) return { ok: { delegations: {} } };

				// Find share delegation
				const resB = await ctx.delegationsStorage.find({ audience: capability.nb.recipient });
				if (resB.error) return { error: resB.error };

				const delegation = resB.ok.find((d) => {
					return d.cid.toString() === shareLink;
				});

				if (!delegation) return { ok: { delegations: {} } };

				// Fin
				return {
					ok: {
						delegations: {
							[attestation.cid.toString()]: delegationsToBytes([attestation]),
							[delegation.cid.toString()]: delegationsToBytes([delegation]),
						},
					},
				};
			}),
			'claim-shares': provide(Clock.claimShares, async ({ capability }) => {
				// Find share attestations
				const resA = await ctx.delegationsStorage.find({ audience: capability.nb.recipient });
				if (resA.error) return { error: resA.error };

				const attestations = resA.ok.filter((d) => {
					const cap = d.capabilities[0];
					return cap && d.issuer.did() === ctx.signer.did() && cap.can === 'ucan/attest';
				});

				// Recipient delegations
				const resB = await ctx.delegationsStorage.find({ audience: capability.nb.recipient });
				if (resB.error) return { error: resB.error };

				type DelegationType = (typeof resB.ok)[number];

				const delegations = resB.ok.reduce((acc: Record<string, DelegationType>, del: DelegationType) => {
					acc[del.cid.toString()] = del;
					return acc;
				}, {});

				// Find associated share delegations
				const items = (
					await Promise.all(
						attestations.map(async (att) => {
							const cap = att.capabilities[0];
							const delegation = cap && delegations[(cap.nb as any).proof.toString()];
							if (!delegation) return null;

							return {
								attestation: att,
								delegation,
							};
						}),
					)
				).filter((a) => a !== null);

				// Fin
				return {
					ok: {
						delegations: Object.fromEntries(
							items.flatMap((item) => {
								return [
									[item.attestation.cid.toString(), delegationsToBytes([item.attestation])],
									[item.delegation.cid.toString(), delegationsToBytes([item.delegation])],
								];
							}),
						),
					},
				};
			}),
			'confirm-share': provide(Clock.confirmShare, async ({ capability, invocation }) => {
				const causeLink = capability.nb.cause;

				// Extra info from causal invocation
				const causeResult = await ctx.agentStore.invocations.get(causeLink);
				if (causeResult.error) return { error: causeResult.error };

				const cause = causeResult.ok;
				const nb: any = cause.capabilities[0]?.nb;
				if (!nb) return { error: new Error('Unable to retrieve capabilities from cause') };

				const proof = nb.proof;
				const audience = nb.recipient;

				// Create attestation & store it
				const attestation = await UCAN.attest.delegate({
					issuer: ctx.signer,
					audience: Server.DID.parse(audience),
					with: ctx.signer.did(),
					nb: { proof },
					expiration: Infinity,
				});

				await ctx.delegationsStorage.putMany([attestation]);

				// Fin
				return { ok: {} };
			}),
			head: provide(Clock.head, async ({ capability }) => {
				const head = await ctx.kvStore.get(`clock/${capability.with}`);

				return {
					ok: { head: head || undefined },
				};
			}),
			register: provide(Clock.register, async ({ capability, invocation, context }) => {
				// This basically only exists to store the clock's genesis delegation on the server.
				if (invocation.proofs[0]?.link().toString() === capability.nb.proof.toString()) {
					const delegations = invocation.proofs.filter((proof) => {
						return 'archive' in proof;
					});

					await ctx.delegationsStorage.putMany(delegations, { cause: invocation.link() });

					return { ok: {} };
				} else {
					return { error: new Server.Failure('Proof linked in capability does not match proof in invocation') };
				}
			}),
		},
		store: {
			// The client must utilise the presigned url to upload the CAR bytes.
			// For more info, see the `store/add` capability:
			// https://github.com/storacha-network/w3up/blob/e53aa87/packages/capabilities/src/store.js#L41
			add: provide(Store.add, async ({ capability }) => {
				const { link, size } = capability.nb;
				const expiresInSeconds = ctx.expiresInSeconds || 60 * 60 * 24; // 1 day

				const endpoint =
					ctx.url.hostname === 'localhost' ? ctx.url.origin : `https://${ctx.bucketName}.${ctx.accountId}.r2.cloudflarestorage.com`;

				const url = new URL(endpoint);
				url.pathname = (ctx.url.hostname === 'localhost' ? '/r2/' : '/') + link.toString();
				url.searchParams.set('X-Amz-Expires', expiresInSeconds.toString());

				const signedUrl = await R2.sign(
					new Request(url, {
						method: 'PUT',
					}),
					{
						aws: { signQuery: true },
					},
				);

				return {
					ok: {
						status: 'upload',
						allocated: size,
						link,
						url: signedUrl.url,
					},
				};
			}),
			get: provide(Store.get, async ({ capability }) => {
				const { link } = capability.nb;
				if (link === undefined) return { error: new Server.Failure('Expected a link to be present') };

				const result = await ctx.bucket.get(link.toString());
				if (result === null) return { ok: { data: undefined } };

				return {
					ok: { data: new Uint8Array(await result.arrayBuffer()) },
				};
			}),
		},
	};
}

////////////////////////////////////////
// SERVER
////////////////////////////////////////

async function createServer(ctx: FireproofServiceContext) {
	return Server.create({
		id: ctx.signer,
		codec: CAR.inbound,
		service: createService(ctx),

		// Manage revocations
		validateAuthorization: async () => ({ ok: {} }),

		// Resolve proofs referenced by CID
		resolve: async (proof) => {
			const data = await ctx.bucket.get(proof.toString());
			if (!data) return { error: new UnavailableProof(proof) };

			const result = await extract(new Uint8Array(await data.arrayBuffer()));
			if (result.error) return { error: new UnavailableProof(proof, result.error) };

			return { ok: result.ok };
		},

		// Who can issue capabilities?
		canIssue: (capability, issuer) => {
			// if (capability.uri.protocol === "file:") {
			//   const [did] = capability.uri.pathname.split("/")
			//   return did === issuer
			// }
			return capability.with === issuer || issuer === ctx.signer.did();
		},
	});
}

////////////////////////////////////////
// HANDLER
////////////////////////////////////////

export default {
	async fetch(request, env, executionContext): Promise<Response> {
		if (request.method === 'OPTIONS') {
			// Handle CORS preflight requests
			return handleOptions(request);
		}

		// Environment
		if (!env.ACCESS_KEY_ID) throw new Error('please set ACCESS_KEY_ID');
		if (!env.ACCOUNT_ID) throw new Error('please set ACCOUNT_ID');
		if (!env.BUCKET_NAME) throw new Error('please set BUCKET_NAME');
		if (!env.FIREPROOF_SERVICE_PRIVATE_KEY) throw new Error('please set FIREPROOF_SERVICE_PRIVATE_KEY');
		if (!env.POSTMARK_TOKEN) throw new Error('please set POSTMARK_TOKEN');
		if (!env.SECRET_ACCESS_KEY) throw new Error('please set SECRET_ACCESS_KEY');

		// @ts-expect-error I think this is unused by the access service
		const provisionsStorage: ProvisionsStorage = null;

		// Parse URL
		const url = new URL(request.url);

		// Signer
		const signer = Signer.parse(env.FIREPROOF_SERVICE_PRIVATE_KEY);

		// Context
		const ctx: FireproofServiceContext = {
			// AccessServiceContext
			signer,
			url,
			email: {
				sendValidation: async ({ to, url }) => {
					if (ctx.emailAddress)
						await Email.send({
							postmarkToken: env.POSTMARK_TOKEN,
							recipient: to,
							sender: ctx.emailAddress,
							template: 'login',
							templateData: {
								product_url: 'https://fireproof.storage',
								product_name: 'Fireproof Storage',
								email: to,
								action_url: url,
							},
						});
				},
			},
			provisionsStorage,
			rateLimitsStorage: {
				add: async () => ({ error: new Server.Failure('Rate limits not supported') }),
				list: async () => ({ ok: [] }),
				remove: async () => ({ error: new Server.Failure('Rate limits not supported') }),
			},
			delegationsStorage: createDelegationStore(env.bucket, env.kv_store),
			agentStore: createAgentStore(env.bucket, env.kv_store),

			// Context
			accessKeyId: env.ACCESS_KEY_ID,
			accountId: env.ACCOUNT_ID,
			bucket: env.bucket,
			bucketName: env.BUCKET_NAME,
			emailAddress: env.EMAIL,
			kvStore: env.kv_store,
			postmarkToken: env.POSTMARK_TOKEN,
			secretAccessKey: env.SECRET_ACCESS_KEY,
		};

		// Create server
		const server = await createServer(ctx);

		// Validate email if asked so
		if (request.method === 'GET' && url.pathname === '/validate-email') {
			await validateEmail({ url, request, server });
			return new Response('Email validated successfully.', { headers: { ContentType: 'text/html' } });
		}

		// R2 upload
		const r2 = url.pathname.match(/^\/r2\/([^(\/|$)]+)\/?$/);
		if (request.method === 'PUT' && r2 && r2[1] && url.hostname === 'localhost') {
			await r2Put({ bucket: ctx.bucket, cid: r2[1], request });

			return new Response(null, { status: 202 });
		}

		// DID
		if (request.method === 'GET' && url.pathname.match(/^\/did\/?$/)) {
			const response = new Response(signer.did(), {
				headers: {
					ContentType: 'text/html;charset=UTF-8',
				},
			});

			response.headers.set('Access-Control-Allow-Origin', '*');
			response.headers.append('Vary', 'Origin');

			return response;
		}

		// Otherwise manage UCANTO RPC request
		if (request.method !== 'POST' || !request.body) {
			throw new Error('Server only accepts POST requests');
		}

		const pieces = await fromAsync(request.body);
		const payload = {
			body: Uint8Arrays.concat(pieces),
			headers: Object.fromEntries(request.headers),
		};

		const result = server.codec.accept(payload);
		if (result.error) {
			throw new Error(`Accept-call failed! ${result.error}`);
		}

		// Decode incoming invocations, execute them and render response
		const { encoder, decoder } = result.ok;
		const incoming = await decoder.decode<
			Server.AgentMessage<{
				Out: API.InferReceipts<API.Tuple<API.ServiceInvocation<API.Capability, Record<string, any>>>, Record<string, any>>;
				In: never; // API.Tuple<API.Invocation>;
			}>
		>(payload);

		const outgoing = await Server.execute(incoming, server);
		const encoded = await encoder.encode(outgoing);

		const response = new Response(encoded.body, { headers: encoded.headers });
		response.headers.set('Access-Control-Allow-Origin', '*');
		response.headers.append('Vary', 'Origin');

		return response;
	},
} satisfies ExportedHandler<Env>;

////////////////////////////////////////
// HANDLER → EMAIL VALIDATION
////////////////////////////////////////

async function validateEmail({ url, request, server }: { url: URL; request: Request; server: API.ServerView<Service> }) {
	const delegation = stringToDelegation(url.searchParams.get('ucan') ?? '');

	if (delegation.capabilities.length !== 1) {
		throw new Error(`Invalidate delegation in validate-email confirmation url`);
	}

	const can = delegation.capabilities[0].can;
	let invocation;

	switch (can) {
		case 'access/confirm':
			invocation = delegation as API.Invocation<AccessConfirm>;
			break;

		case 'clock/confirm-share':
			invocation = delegation as API.Invocation<Server.InferInvokedCapability<typeof Clock.confirmShare>>;
			break;

		default:
			throw new Error(`Invalidate delegation in validate-email confirmation url`);
	}

	const message = (await Message.build({
		invocations: [invocation],
	})) as Server.AgentMessage<{
		Out: API.InferReceipts<API.Tuple<API.ServiceInvocation<API.Capability, Record<string, any>>>, Record<string, any>>;
		In: never; // API.Tuple<API.Invocation>;
	}>;

	server.codec.accept({
		body: new Uint8Array(),
		headers: Object.fromEntries(request.headers),
	});

	const resp = await Server.execute(message, server);
	const err = Array.from(resp.receipts).find(([_, r]) => !!r.out.error)?.[1]?.out?.error;
	if (err) throw err;
}

////////////////////////////////////////
// HANDLER → R2
////////////////////////////////////////

export async function r2Put({ bucket, cid, request }: { bucket: R2Bucket; cid: string; request: Request }) {
	const bytes = request.body && Uint8Arrays.concat(await all(request.body));

	if (!bytes) throw new Error('Expected a request body');

	// const url = new URL(request.url);
	// TODO: check if link is expired and if store/add capability was invoked

	const givenCID = CID.parse(cid);
	const hash = await ShaHash.sha256.digest(bytes);

	if (Uint8Arrays.compare(givenCID.multihash.digest, hash.digest) !== 0) {
		throw new Error('Content did not match given CID');
	}

	await bucket.put(cid, bytes);
}

// 🛠️

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
	'Access-Control-Max-Age': '86400',
};

async function handleOptions(request: Request) {
	if (
		request.headers.get('Origin') !== null &&
		request.headers.get('Access-Control-Request-Method') !== null &&
		request.headers.get('Access-Control-Request-Headers') !== null
	) {
		// Handle CORS preflight requests.
		return new Response(null, {
			headers: {
				...CORS_HEADERS,
				'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '',
			},
		});
	} else {
		// Handle standard OPTIONS request.
		return new Response(null, {
			headers: {
				Allow: 'GET, HEAD, POST, OPTIONS',
			},
		});
	}
}
