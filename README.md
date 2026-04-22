# aigateway-js (Node / TypeScript SDK)

Official Node SDK for [AIgateway](https://aigateway.sh) — one OpenAI-compatible API for every frontier and open-weight model, every modality.

> Distribution name on npm is **`aigateway-js`** (the bare `aigateway` name was unavailable). All imports use the `aigateway-js` specifier.

For **chat, embeddings, images, STT, TTS, moderation** — just use the `openai` package with `baseURL: 'https://api.aigateway.sh/v1'`. AIgateway is drop-in.

This SDK covers the aggregator-native surface OpenAI doesn't model:

- **Async jobs** — text-to-video, music, 3D with typed `jobs.wait(id)` helpers
- **Sub-accounts** — one scoped key per end customer with spend caps
- **Evals** — pick the winning model from a candidate set; alias as `eval:<run_id>`
- **Replays** — re-run any past request against a new model and diff the output
- **Signed file URLs** — share job results without handing out the gateway key
- **Webhook signature verification** — HMAC-SHA256 with `verifyWebhook()`

## Install

```sh
pnpm add aigateway-js     # or npm install aigateway-js / yarn add aigateway-js
```

Node 18+ required (for built-in `fetch`). ESM + CJS exports. Works in Workers, Edge runtimes, Deno, Bun.

## Quickstart

```ts
import { AIgateway, verifyWebhook } from "aigateway-js";

const client = new AIgateway({ apiKey: process.env.AIGATEWAY_API_KEY! });

// 1. Submit a video job with a webhook.
const job = await client.jobs.createVideo({
  prompt: "a sunset over mountains, cinematic",
  model: "runwayml/gen-4",
  duration: 5,
  webhookUrl: "https://yourapp.com/hooks/aigateway",
});

// 2. Or poll until it's done:
const done = await client.jobs.wait(job.id, { timeoutSeconds: 600 });
console.log(done.resultUrl);

// 3. Mint a shareable signed URL:
const { url } = await client.files.signedUrl(job.id, "video.mp4", 3600);
```

## Webhook verification

```ts
import { verifyWebhook } from "aigateway-js";

app.post("/hooks/aigateway", async (req, res) => {
  const raw = await req.text();
  const ok = verifyWebhook({
    secret: process.env.AIGATEWAY_WEBHOOK_SECRET!,
    body: raw,
    header: req.headers["x-gateway-signature"] as string,
  });
  if (!ok) return res.status(401).end();
  // ... handle the payload
});
```

Fetch your webhook secret with `client.webhookSecret.get()` or rotate it with `client.webhookSecret.rotate()`.

## Aggregator primitives

```ts
// Mint a scoped key for one of your customers.
const sub = await client.subAccounts.create({
  name: "customer-123",
  spendCapCents: 10_000,
  defaultTag: "customer-123",
});

// Run an eval across candidate models.
const run = await client.evals.create({
  name: "prod-summarize",
  candidateModels: ["anthropic/claude-opus-4.7", "moonshot/kimi-k2.6"],
  dataset: [{ input: "…", expected: "…" }],
  metric: "quality",
});
// Then route to the winner automatically by using `model: "eval:<run.id>"`.

// Replay a request on a new model.
const replay = await client.replays.run({
  sourceRequestId: "req_abc",
  targetModel: "anthropic/claude-opus-4.7",
});
```

## Related packages

- **CLI** — [`aigateway-cli`](https://www.npmjs.com/package/aigateway-cli) — installs the `aig` binary. Run `aig init` to walk through key + scaffold a starter file.
- **Python SDK** — [`aigateway-py`](https://pypi.org/project/aigateway-py/) — same surface, `pip install aigateway-py`.
- **MCP server** — `https://api.aigateway.sh/mcp` (Streamable HTTP) and `/mcp/sse` (legacy). Inspect at `/mcp/inspect`.

## Source, issues, examples

- Source — [github.com/aigateway-sh/sdk-node](https://github.com/aigateway-sh/sdk-node)
- Issues — [github.com/aigateway-sh/sdk-node/issues](https://github.com/aigateway-sh/sdk-node/issues)
- Working examples — [github.com/aigateway-sh/examples](https://github.com/aigateway-sh/examples)
- Support — **support@aigateway.sh** · [aigateway.sh/support](https://aigateway.sh/support)
- Follow — [github.com/aigateway-sh](https://github.com/aigateway-sh) · [linkedin.com/in/rakeshroushan1002](https://www.linkedin.com/in/rakeshroushan1002/) · [x.com/buildwithrakesh](https://x.com/buildwithrakesh)

## License

MIT © AIgateway
