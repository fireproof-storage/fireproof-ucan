### Setup

Generate a key:

```bash
npx ucan-key ed --json
```

and into `.dev.vars`:

```
FIREPROOF_SERVICE_PRIVATE_KEY = <private key>

```

and then https://dash.cloudflare.com/cae1c33213e6c4d3093a01ae8a7e24b0/r2/api-tokens to create API tokens


### Local development

```shell
pnpm run dev
```
