import * as API from '@web3-storage/upload-api/types';
import { CAR, Invocation, Receipt } from '@ucanto/core';
import { RecordNotFound } from '@web3-storage/upload-api/errors';

// 🚀
export function create() {
	return new AgentStore();
}

// TYPES

interface Model {
	readonly store: Record<string, CAR.Model>;
	readonly index: Record<string, { root: API.Link; at: string }[]>;
}

// IMPLEMENTATION

class AgentStore implements API.AgentStore {
	readonly model: Model;
	readonly invocations: InvocationLookup;
	readonly receipts: ReceiptLookup;

	constructor({ store = {}, index = {} } = {}) {
		const model = { store, index };
		this.model = model;

		this.invocations = new InvocationLookup(model);
		this.receipts = new ReceiptLookup(model);
	}

	get messages() {
		return this;
	}

	/**
	 */
	async write(message: API.ParsedAgentMessage): Promise<API.Result<API.Unit, API.WriteError<API.ParsedAgentMessage>>> {
		const { index, store } = this.model;
		const at = message.data.root.cid.toString();
		store[at] = CAR.decode(message.source.body as Uint8Array);

		for (const { invocation, receipt } of message.index) {
			if (invocation) {
				const entry = index[`/${invocation.task.toString()}/invocation/`] ?? [];
				entry.push({ root: invocation.invocation.link(), at });
				index[`/${invocation.task.toString()}/invocation/`] = entry;
			}

			if (receipt) {
				const entry = index[`/${receipt.task.toString()}/receipt/`] ?? [];
				entry.push({ root: receipt.receipt.link(), at });
				index[`/${receipt.task.toString()}/receipt/`] = entry;
			}
		}

		return { ok: {} };
	}
}

class InvocationLookup {
	readonly model: Model;

	/**
	 * @param {Model} model
	 */
	constructor(model: Model) {
		this.model = model;
	}

	async get(key: API.UnknownLink): Promise<API.Result<API.Invocation, API.RecordNotFound>> {
		const { index, store } = this.model;
		const record = index[`/${key.toString()}/invocation/`]?.[0];
		const archive = record ? store[record.at] : null;
		const value = archive
			? // @ts-ignore TODO figure out this type error
				Invocation.view({ root: record.root, blocks: archive.blocks }, null)
			: null;

		return value ? { ok: value } : { error: new RecordNotFound() };
	}
}

class ReceiptLookup {
	readonly model: Model;

	constructor(model: Model) {
		this.model = model;
	}

	async get(key: API.UnknownLink): Promise<API.Result<API.Receipt, API.RecordNotFound>> {
		const { index, store } = this.model;
		const record = index[`/${key.toString()}/receipt/`]?.[0];
		const archive = record ? store[record.at] : null;
		const value = archive
			? // @ts-ignore TODO figure out this type error
				Receipt.view({ root: record.root, blocks: archive.blocks }, null)
			: null;

		return value ? { ok: value } : { error: new RecordNotFound() };
	}
}
