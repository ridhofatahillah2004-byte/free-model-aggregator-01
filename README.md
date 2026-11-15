# Free Model Aggregator

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/free-model-aggregator-01)

One server, two APIs, ten free-tier providers. This is an OpenAI- and
Anthropic-compatible chat server that routes each request to the best free
model that can serve it, failing over when a provider refuses.

## Run

```sh
node main.ts            # register with the env, serve the trial, exit 0
node main.ts --list     # print the model catalog and exit 0
```

Node 22, standard library only. No dependencies, no wall clock and no
unseeded randomness in any output — every run of the same trial is
deterministic.

## How it works

- **Brief first.** On startup it reads the trial brief (`MAKEFUN_PROMPT_FILE`)
  for the provider directory and the quality table, and the env's
  `/instance` endpoint for absolute base URLs and the workload manifest.
- **Catalog from the source.** It probes each provider's own catalog route
  (`GET /v1/models`, or `/v1beta/models` for Gemini) and registers exactly
  what the providers report — free models only, with their context lengths.
- **Routing.** For each request it picks the highest-rated free model that
  meets the request's requirements (tools, vision, JSON, minimum context).
  JSON-mode OpenAI requests are only sent to OpenAI or Gemini wires.
- **Failover.** Candidates are tried in rating order; a provider that
  refuses (402/429) is skipped, and a provider that fails three calls in a
  row drops to the back of the queue. After one full pass the smallest
  `retry-after` seen is honored (capped at 2 s) before a second pass.
- **Faithful translation.** System prompts, user text, images, tool
  definitions, `max_tokens`, stop sequences and JSON mode are carried
  verbatim across the three provider wires (OpenAI, Anthropic, Gemini), and
  the provider's own token usage is reported back unchanged.
- **Streaming.** Provider answers are buffered, then re-emitted as clean
  server-sent events in the client's wire, with usage included.

Built for the [free-model-aggregator-01 bounty](https://make.fun/bounty/free-model-aggregator-01) on make.fun.
