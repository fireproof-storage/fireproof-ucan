import * as API from '@web3-storage/upload-api/types';
import * as Server from '@ucanto/server';

import { DelegationsStorageQuery } from '@web3-storage/upload-api';
import { extract } from '@ucanto/core/delegation';

// 🚀
export function create(bucket: R2Bucket, kv: KVNamespace) {
	return new DelegationStore(bucket, kv);
}

// TYPES

interface KVRecord {
	readonly data: string;

	readonly issuer: string;
	readonly audience: string;
};

// IMPLEMENTATION

class DelegationStore implements API.DelegationsStorage {
	readonly bucket: R2Bucket;
	readonly kv: KVNamespace;

	constructor(bucket: R2Bucket, kv: KVNamespace) {
		this.bucket = bucket;
		this.kv = kv;
	}

	async putMany(delegations: Server.API.Delegation[]) {
		await Promise.all(
			delegations.map(async (d) => {
				const result = await d.archive();
				if (result.error) throw result.error;

				const car = result.ok;
				const link = d.cid.toString();
				const record: KVRecord = {
					data: link,

					issuer: d.issuer.did(),
					audience: d.audience.did(),
				};

				await this.bucket.put(link, car);
				await this.kv.put(`delegation/${d.audience.did()}/${link}`, JSON.stringify(record));
			}),
		);

		return { ok: {} };
	}

	async count() {
		const list = await fullList(this.kv, 'delegation/');
		return BigInt(list.length);
	}

	async find(query: DelegationsStorageQuery) {
		const list = await fullList(this.kv, `delegation/${query.audience}/`);
		const results: Array<Server.API.Delegation | null> = await Promise.all(
			list.map(async (key) => {
				const record = await this.kv.get<KVRecord>(key.name, 'json');
				if (record === null) return null;

				const data = await this.bucket.get(record.data);
				if (!data) return null;

				const result = await extract(new Uint8Array(await data.arrayBuffer()));
				if (result.error) throw result.error;

				return result.ok;
			}),
		);

		const delegations: Server.API.Delegation[] = results.filter((r) => r !== null);
		return { ok: delegations };
	}
}

// 🛠️

async function fullList(kv: KVNamespace, prefix: string, cursor?: { cursor: string; previous: KVNamespaceListKey<unknown, string>[] }) {
	const result = await kv.list({ cursor: cursor ? cursor.cursor : undefined, prefix });
	const list = [...(cursor?.previous || []), ...result.keys];
	if (result.list_complete) return list;
	return fullList(kv, prefix, { cursor: result.cursor, previous: list });
}
