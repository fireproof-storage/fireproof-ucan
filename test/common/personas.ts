import * as DidMailto from '@web3-storage/did-mailto';

import { Absentee } from '@ucanto/principal';
import { Signer } from '@ucanto/principal/ed25519';
import { env } from 'cloudflare:test';

// 🙋

export const alice = Absentee.from({ id: DidMailto.fromEmail('alice@example.com') });
export const bob = Absentee.from({ id: DidMailto.fromEmail('bob@example.com') });
export const server = Signer.parse(env.FIREPROOF_SERVICE_PRIVATE_KEY);
