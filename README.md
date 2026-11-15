# Free Model Aggregator

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/ridhofatahillah2004-byte/free-model-aggregator-01/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/ridhofatahillah2004-byte/free-model-aggregator-01/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
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
- **Routing.** The score caps at 99 — the best model for 17 of the 20
  requests is one provider's, whose per-trial budget is 10–12 calls — so
  the board is decided by the tie-break: the number of provider calls.
  Candidates are therefore ranked by expected value, not by rating alone:
  each provider's next call is priced by its failure risk, estimated from
  the competition's published budget ranges (a small-budget provider's 2nd
  call fails far more often than a large-budget one's), plus budget
  exhaustion and the one outage as the call count grows. Capacity is
  reserved for constrained requests (vision, long context) by sparing
  providers that few future requests can use, and a provider that fails
  twice in a row is treated as out. A quality guard drops every penalty
  once the weighted rating lost so far reaches 600, so the score never
  slips below 99 for the sake of a saved call. One pass only: a provider
  that refuses is never retried for the same request.
  JSON-mode OpenAI requests are only sent to OpenAI or Gemini wires.
- **Failover.** A refusal (402/429) is answered by the next candidate in
  expected-value order. Practice trials: 22/21/22 upstream calls at score
  99 (was 28/31/31 with plain rating order).
- **Faithful translation.** System prompts, user text, images, tool
  definitions, `max_tokens`, stop sequences and JSON mode are carried
  verbatim across the three provider wires (OpenAI, Anthropic, Gemini), and
  the provider's own token usage is reported back unchanged.
- **Streaming.** Provider answers are buffered, then re-emitted as clean
  server-sent events in the client's wire, with usage included.

Built for the [free-model-aggregator-01 bounty](https://make.fun/bounty/free-model-aggregator-01) on make.fun.
