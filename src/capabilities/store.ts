import { Link as LinkType, ParsedCapability, URI } from '@ucanto/interface';
import { capability, fail, ok, DID, Link, Schema } from '@ucanto/validator';

// @see https://github.com/multiformats/multicodec/blob/master/table.csv#L140
export const code = 0x0202;
export const CARLink = Schema.link({ code, version: 1 });

/**
 * `store/add` capability allows agent to store a CAR file into a (memory) space
 * identified by did:key in the `with` field. Agent must precompute CAR locally
 * and provide it's CID and size using `nb.link` and `nb.size` fields, allowing
 * a service to provision a write location for the agent to PUT or POST desired
 * CAR into.
 */
export const add = capability({
	can: 'store/add',
	with: DID,
	nb: Schema.struct({
		/**
		 * CID of the CAR file to be stored. Service will provision write target
		 * for this exact CAR file for agent to PUT or POST it. Attempt to write
		 * any other content will fail.
		 */
		link: Link,
		/**
		 * Size of the CAR file to be stored. Service will provision write target
		 * for this exact size. Attempt to write a larger CAR file will fail.
		 */
		size: Schema.integer(),
		/**
		 * Agent may optionally provide a link to a related CAR file using `origin`
		 * field. This is useful when storing large DAGs, agent could shard it
		 * across multiple CAR files and then link each shard with a previous one.
		 *
		 * Providing this relation tells service that given CAR is shard of the
		 * larger DAG as opposed to it being intentionally partial DAG. When DAG is
		 * not sharded, there will be only one `store/add` with `origin` left out.
		 */
		origin: Link.optional(),
	}),
	derives: (claim, from) => {
		const result = equalLink(claim, from);
		if (result.error) {
			return result;
		} else if (!(typeof claim.nb.size === "number" && typeof from.nb.size === "number")) {
			return claim.nb.size > from.nb.size ? fail(`Size constraint violation: ${claim.nb.size} > ${from.nb.size}`) : ok({});
		} else {
			return ok({});
		}
	},
});

/**
 * Capability to get store metadata by shard CID.
 * Use to check for inclusion, or get shard size and origin
 *
 * `nb.link` is optional to allow delegation of `store/get`
 * capability for any shard CID. If link is specified, then the
 * capability only allows a get for that specific CID.
 *
 * When used as as an invocation, `nb.link` must be specified.
 */
export const get = capability({
	can: 'store/get',
	with: DID,
	nb: Schema.struct({
		/**
		 * shard CID to fetch info about.
		 */
		link: Link,
	}),
	derives: equalLink,
});

// 🛠️

export function equalLink<
	T extends ParsedCapability<'store/add' | 'store/get', URI<'did:'>, { link?: LinkType<unknown, number, number, 0 | 1> }>,
>(claimed: T, delegated: T) {
	if (claimed.with !== delegated.with) {
		return fail(`Expected 'with: "${delegated.with}"' instead got '${claimed.with}'`);
	} else if (delegated.nb.link && `${delegated.nb.link}` !== `${claimed.nb.link}`) {
		return fail(`Link ${claimed.nb.link ? `${claimed.nb.link}` : ''} violates imposed ${delegated.nb.link} constraint.`);
	} else {
		return ok({});
	}
}
