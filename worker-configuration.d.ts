// Generated by Wrangler on Fri Aug 16 2024 13:55:06 GMT+0200 (Central European Summer Time)
// by running `wrangler types`

import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
	bucket: R2Bucket;
	delegation_store: KVNamespace;

	ACCESS_KEY_ID: string;
	ACCOUNT_ID: string;
	BUCKET_NAME: string;
	CLOUDFLARE_API_TOKEN: string;
	FIREPROOF_SERVICE_PRIVATE_KEY: string;
	POSTMARK_TOKEN: string;
	SECRET_ACCESS_KEY: string;
	SERVICE_ID: string;
}
