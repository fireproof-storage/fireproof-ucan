import * as API from '@web3-storage/upload-api/types';
import * as Server from '@ucanto/server';
import { DelegationsStorageQuery } from '@web3-storage/upload-api';

// 🚀
export function create() {
	return new DelegationStore();
}

// IMPLEMENTATION

class DelegationStore implements API.DelegationsStorage {
	readonly store: Server.API.Delegation[] = []

	async putMany(delegations: Server.API.Delegation[]) {
		this.store.push(...delegations);
		return { ok: {} };
	}

	async count() {
		return BigInt(this.store.length);
	}

	async find(query: DelegationsStorageQuery) {
		return { ok: this.store.filter((delegation) => delegation.audience.did() === query.audience) };
	}
}
