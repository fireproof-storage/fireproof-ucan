import * as API from '@ucanto/interface';
import { access, Schema, Failure, StoreGetterConfig } from './validator/lib';

/**
 * Goal here is to make `ucan:*` get the proofs from the delegation store as well.
 */

export const provideConstructor =
	(config: StoreGetterConfig) =>
	<
		A extends API.Ability,
		R extends API.URI,
		C extends API.Caveats,
		O extends {},
		X extends API.Failure,
		Result extends API.Transaction<O, X>,
	>(
		capability: API.CapabilityParser<API.Match<API.ParsedCapability<A, R, C>>>,
		handler: (input: API.ProviderInput<API.ParsedCapability<A, R, C>>) => API.Await<Result>,
	) =>
		provideAdvanced({ capability, config, handler });

/////////////////////////////
// 🐇 Down the rabbit hole //
/////////////////////////////

export const provideAdvanced =
	<
		A extends API.Ability,
		R extends API.URI,
		C extends API.Caveats,
		O extends {},
		X extends API.Failure,
		Result extends API.Transaction<O, X>,
	>({
		capability,
		handler,
		audience,
		config,
	}: {
		audience?: API.Reader<API.DID>;
		capability: API.CapabilityParser<API.Match<API.ParsedCapability<A, R, C>>>;
		config?: StoreGetterConfig;
		handler: (input: API.ProviderInput<API.ParsedCapability<A, R, C>>) => API.Await<Result>;
	}): API.ServiceMethod<API.Capability<A, R, C>, O & API.InferTransaction<Result>['ok'], X & API.InferTransaction<Result>['error']> =>
	async (invocation: API.Invocation<API.Capability<A, R, C>>, options: API.InvocationContext) => {
		// If audience schema is not provided we expect the audience to match
		// the server id. Users could pass `schema.string()` if they want to accept
		// any audience.
		const audienceSchema = audience || Schema.literal(options.id.did());
		const result = audienceSchema.read(invocation.audience.did());
		if (result.error) {
			return { error: new InvalidAudience({ cause: result.error }) };
		}

		const authorization = await access(invocation, {
			...options,
			...config,
			authority: options.id,
			capability,
		});

		if (authorization.error) {
			return authorization;
		} else {
			return handler({
				capability: authorization.ok.capability,
				invocation,
				context: options,
			});
		}
	};

/**
 * @implements {API.InvalidAudience}
 */
class InvalidAudience extends Failure {
	readonly cause: API.Failure;

	constructor({ cause }: { cause: API.Failure }) {
		super();
		this.name = 'InvalidAudience';
		this.cause = cause;
	}
	describe() {
		return this.cause.message;
	}
}
