# Subscription sign-in and search findings

Research answer for [issue 15](https://github.com/zaingulel/kestrel/issues/15) and [issue 16](https://github.com/zaingulel/kestrel/issues/16). This is a research record from sources read on 13 October 2026; prices, plans and eligibility may have changed since. It is not an operating manual or an enabled configuration.

## Recommendation

For the brain comparison, treat ChatGPT subscription access as a candidate with a permission and endpoint check still outstanding. Hermes supports the older Codex sign-in, while OpenAI now documents a distinct, authorised integration for local open-source applications using eligible Plus and Pro plans. Those are different flows. Do not assume the installed Hermes flow satisfies that newer contract. Direct Claude subscription tokens are not a defensible substitute: Anthropic restricts third-party Claude.ai login. [OpenAI application integration](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), [Anthropic authentication restrictions](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

For search, recommend **Hermes's native DDGS adapter for occasional, search-only prototype lookups**, with the already chosen brain producing a brief answer and retaining the returned source URLs. It needs no search billing account or key. Keep separately billed extraction and all paid fallbacks off. This is a recommendation for the later lookup job, not evidence that today's installation is configured safely or ready to search. DDGS is absent from the inspected environment. Its current automatic routing can contact several engines, despite Hermes calling the adapter DuckDuckGo.

“No metered billing” here means included subscription usage or a genuinely free search route only. Purchased credits, overage budgets, prepaid pay-as-you-go balances and automatic top-ups remain metered consumption, even if the debit happens before the conversation.

## Source identity and limits

Installed source root: `/home/zain/.local/share/mise/installs/pipx-hermes-agent/0.19.0/hermes-agent/lib/python3.13/site-packages`. The package metadata and CLI version both identify **hermes-agent 0.19.0**; the entry point is `hermes_cli.main:main`. No distribution `direct_url.json` supplies an installed commit, so no source commit is claimed for those bytes.

Current upstream source inspected separately: [Hermes commit 3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065](https://github.com/NousResearch/hermes-agent/commit/3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065). Its package version is an installation-stamp placeholder; the commit identifies the comparison. DDGS routing inspected at [commit 70a5635510fb8d5b15d5ba6ceced6a67e212149b](https://github.com/deedy5/ddgs/tree/70a5635510fb8d5b15d5ba6ceced6a67e212149b). That DDGS revision is prospective evidence, not an installed dependency pin.

Installed evidence locations, relative to the source root above:

| Evidence | Inspected location |
|---|---|
| OAuth provider registry, default endpoints and Codex device login | `hermes_cli/auth.py:176`, `:7030` |
| Claude browser authorisation and Pro/Max label | `agent/anthropic_adapter.py:1434` |
| Copilot device login and external CLI integration | `hermes_cli/copilot_auth.py:165`; `agent/copilot_acp_client.py:396` |
| System context, history and tool definitions sent to inference | `agent/system_prompt.py:147`; `agent/conversation_loop.py:870`; `agent/chat_completion_helpers.py:984` |
| Auxiliary model and fallback selection | `agent/auxiliary_client.py:4379`; `agent/chat_completion_helpers.py:1537` |
| DDGS call, returned URLs/snippets, missing dependency and errors | `plugins/web/ddgs/provider.py:32`, `:95` |
| Search provider selection and capability fallback | `tools/web_tools.py:223`, `:686`; `agent/web_search_registry.py:12` |
| Installed xAI search registration and OAuth/API-key fallback | `plugins/web/xai/__init__.py:12`; `plugins/web/xai/provider.py:148`; `tools/xai_http.py:243` |

Source fingerprints using SHA-256 (Secure Hash Algorithm 256-bit):

```text
hermes_cli/auth.py                 dfab38acf45f7db0ceaa993597bf45e15ea759f24bcedbd43d18dd6c596a1164
agent/anthropic_adapter.py        45db88d552660a9311f980299de6ac20e4aeb44948bcd77b69c41e055a95539a
plugins/web/ddgs/provider.py      932a7e3bfceb670078b21a66e433e63ca7224d741f69cde7dcf6e85e791d4c04
agent/auxiliary_client.py         5ea83f6b055689612963e41d01932072a1ccfbd56a5e0b5334bb9dc46bce2671
tools/web_tools.py               2a34e9161480696ed13650a6e171f81010ef8c6261e0f40cd04dc00178583978
```

No authentication stores, credentials, user configuration or runtime assets were read. No signed-in inference or live engine search was executed. Account eligibility, remaining allowance, speed, reliability and the owner's actual configuration remain untested. Public documentation and source retrieval are the evidence, not a successful provider sign-in.

## Issue 15: accepted plans and permission

OAuth is a browser authorisation mechanism. Its presence in Hermes establishes implementation support, not a provider promise about permitted use or account entitlement.

| Installed sign-in route | Named plans and source | What is established |
|---|---|---|
| OpenAI Codex, `openai-codex` | OpenAI currently lists ChatGPT **Free, Go, Plus, Pro, Business, Edu and Enterprise** as including Codex. Free and Go specifically show desktop Luna access subject to rollout. [Codex pricing](https://learn.chatgpt.com/docs/pricing). | Installed Hermes uses its own device flow and defaults to `https://chatgpt.com/backend-api/codex`. General Codex inclusion does not prove every plan/model works on that endpoint. The newer local application integration explicitly names eligible **Plus and Pro**. [Application eligibility](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt). It uses dynamic registration and eligible Responses requests, unlike the installed flow. [Application overview](https://developers.openai.com/siwc/token-sharing-open-source). |
| Anthropic browser OAuth or imported subscription token | Installed browser text names **Claude Pro and Max**. Anthropic's native OAuth documentation also names **Free, Team and Enterprise** for its own applications. [Anthropic policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). | Technical token support exists. Anthropic expressly restricts third-party developers offering Claude.ai login and routing users through Free/Pro/Max credentials. It separately permits users signing into an unmodified Claude Code binary. Hermes's direct adapter is not that binary. Reject direct Claude subscription login for this comparison. |
| Nous Portal, `nous` | Official paid plans: **Plus** $20/month with $22 credits; **Super** $100/month with $110 credits; **Ultra** $200/month with $220 credits. **Free** has $0 monthly credits and free models only. [Nous plan page](https://portal.nousresearch.com/manage-subscription). | First-party Hermes integration is expressly offered. These are credit allowances shared by models and hosted tools, not unlimited inference. A Claude or ChatGPT subscription does not pay the Nous bill. [Nous integration](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal). |
| xAI Grok OAuth, `xai-oauth` | Hermes names **SuperGrok** or linked **X Premium+**. [Pinned Hermes guide](https://github.com/NousResearch/hermes-agent/blob/3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065/website/docs/guides/xai-grok-oauth.md). | The guide warns that OAuth may still return a tier-based 403 despite an active subscription. An exact provider-authorised Hermes allowance and accepted-tier list were not established from xAI's public documentation. Do not certify this as an unlimited or guaranteed no-metered route. The suggested API-key workaround is paid. [xAI API pricing](https://docs.x.ai/developers/pricing). |
| Qwen OAuth, `qwen-oauth` | Current Qwen documentation labels this **discontinued**, rather than an available subscription tier. [Qwen authentication](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/). | Hermes retains the path, but Qwen says its OAuth free tier is discontinued and new requests are rejected. Do not rely on the old 2,000-requests/day claim. Alibaba Coding Plan and standard API keys are separate products, not this login. |
| MiniMax OAuth, `minimax-oauth` | Current **M Plan Go, Explore and Build** tiers include text models. [M Plan overview](https://platform.minimax.io/docs/m-plan/intro). MiniMax explicitly documents **Hermes OAuth** requiring an active M Plan. [MiniMax Hermes setup](https://platform.minimax.io/docs/m-plan/hermes-agent). | This is provider-documented integration, including the international endpoint. Model entitlement still depends on the account. OAuth avoids an API key, but purchased credit packs can fund additional consumption. It is a separate subscription from ChatGPT/Claude. |
| GitHub Copilot device login or `copilot-acp` | GitHub says its CLI is available on **all Copilot plans** with applicable organisation policy enabled. Current individual plans include **Free, Student, Pro, Pro+ and Max**; organisation plans include **Business and Enterprise**. [CLI eligibility](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview), [plan names](https://docs.github.com/en/copilot/get-started/plans). | Installed direct mode obtains a device token; ACP (Agent Client Protocol) mode launches the official local Copilot CLI. Official CLI access does not prove permission for every direct private-endpoint client. Prefer the documented CLI boundary if this becomes relevant, and verify additional-usage budgets before use. |

Other installed coding-plan providers using keys, such as Alibaba Coding Plan, Z.AI and Kimi, are not subscription sign-in flows. Their presence does not extend an existing Claude or ChatGPT subscription. Ordinary API providers are billing escape routes below, not alternative subscription permissions.

### How conversations use the allowance

Hermes sends the retained conversation history, not only the latest spoken sentence. It assembles system instructions and context, passes enabled tool definitions, then includes tool calls and results in subsequent model requests. Search results and fetched text therefore become model input when the brain uses them. Multiple model requests can occur within one user turn. Long context, output and reasoning can consume more allowance even when the final spoken answer is short. This is directly visible in the installed request assembly listed above.

Provider accounting differs:

- **OpenAI:** model, context, reasoning, tools, retrieval and caching affect consumption; message estimates are not guaranteed limits. Local and cloud usage share the allowance, with weekly limits potentially applying. Purchased credits can extend use. [Codex usage rules](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan). In the newer application contract, Plus shares its five-hour allowance across authorised applications; Pro currently has no five-hour limit. Neither fact means unlimited use. [Application sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).
- **Nous:** chosen model and hosted tool use spend the subscription's credit balance. The Portal may route models through other providers; these are still charged against Nous, not the owner's separate lab subscription. [Nous gateway](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal).
- **MiniMax:** all supported tools share M Plan usage. Text requires remaining allowance in both five-hour and weekly windows. Consumption varies with context and complexity. Eligible overflow deducts purchased credit packs. [Usage rules](https://platform.minimax.io/docs/m-plan/usage-rules).
- **Copilot:** current billing measures model-priced input, output and cached tokens in GitHub AI Credits; longer conversations and multiple agent requests use more. Included balances reset monthly. Some existing annual Pro/Pro+ accounts retain legacy request-based billing, so the account's own billing regime matters. [Current billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing), [legacy exception](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests).

There is no defensible conversion from minutes of conversation to a fixed allowance using these sources. Auxiliary work matters too: installed Hermes's auto-selection first tries the main model, then can seek OpenRouter, Nous, custom, Codex or API-key alternatives for compression, vision and other side tasks. Main-provider fallback chains can also change providers. Both consume additional inference and can reach paid accounts.

### Routes to keep off

| Potential metered route | Boundary required for a no-metered comparison |
|---|---|
| Direct model API keys, aggregators and cloud inference | Keep OpenAI API, Anthropic API, xAI API, OpenRouter, custom paid endpoints, AWS Bedrock, Google cloud/AI APIs and Azure inference outside the comparison. Subscription login does not fund those requests. [OpenAI authentication and billing](https://learn.chatgpt.com/docs/auth#sign-in-with-an-api-key). |
| Extra subscription usage | No purchased-credit consumption, auto-refill or overage budgets. This includes OpenAI credits, Claude extra usage, Copilot additional usage and MiniMax credit packs. MiniMax distinguishes subscription keys from pay-as-you-go keys. [MiniMax FAQ](https://platform.minimax.io/docs/m-plan/faq), [Copilot overage](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing#what-happens-if-i-exceed-my-included-ai-credits). |
| Auxiliary calls, fallback chains, credential pools and delegated models | A subscription-only main model is insufficient. Every reachable auxiliary/fallback model must satisfy the same included-only boundary; fail when allowance is unavailable. Installed source shows these routes, but their actual configured values were not inspected. |
| Search, extraction and hosted tools | Keep keyed Firecrawl, Tavily, Exa and Parallel, Brave's priced API, installed xAI search including its fallback to `XAI_API_KEY`, Nous hosted tool credit spending, hosted browser/terminal, image, speech and transcription services outside the route. Free trial credits do not establish unmetered operation. See the alternative table below. |
| Provider switch after a limit or auth error | Do not follow “use an API key” workarounds or substitute a paid provider. Report the limit or unavailable entitlement and wait. Installed Hermes is not proven to enforce this outcome automatically. |

## Issue 16: no-per-use search

### Why DDGS is the recommendation

The installed DDGS adapter already returns title, original URL, snippet and rank without a search account or key. DuckDuckGo explicitly says Search is free. DDGS is MIT-licensed source, but its README calls it educational-purpose software; it is an unofficial search client, not a contracted DuckDuckGo API. [DuckDuckGo cost](https://duckduckgo.com/duckduckgo-help-pages/get-duckduckgo/how-much-does-duckduckgo-cost), [DDGS source and disclaimer](https://github.com/deedy5/ddgs/blob/70a5635510fb8d5b15d5ba6ceced6a67e212149b/README.md).

**The no-billing conclusion is a bounded source inference:** the inspected adapter and DDGS web-engine paths make unauthenticated public search requests, with no metered account, payment credential or priced search API attached. This does not promise unlimited searches or provider authorisation for arbitrary automated workloads. DuckDuckGo's terms permit suspension and disclaim uninterrupted service; its acceptable-use policy prohibits disruption, resale and other unauthorised uses. No explicit automated-search quota or service guarantee was found. [Terms](https://duckduckgo.com/terms), [acceptable use](https://duckduckgo.com/acceptable-use).

For this local prototype, native adapter reuse is preferable to adding a server or new paid account. A short answer can use the snippets as limited evidence and retain the actual returned URLs. A search snippet is not proof that the full page was read. If it cannot support the answer, report that limitation. Full-page reading requires a separately approved direct-fetch path or another confirmed free extractor; do not quietly invoke Hermes's default `web_extract`.

### What leaves the machine

| Step | Data and recipients |
|---|---|
| Search request | The generated query, search parameters, public IP (Internet Protocol) address and HTTP (Hypertext Transfer Protocol) client metadata go to the selected engine. A query can itself reveal conversation details. Hermes's wrapper supplies no conversation transcript, system prompt or microphone audio to DDGS, but the model can include personal details when composing a query. |
| DDGS automatic routing | The inspected wrapper leaves `backend` unspecified. Current DDGS defaults to automatic engine selection. Possible enabled recipients at the pinned revision are **Brave, DuckDuckGo, Google, Grokipedia, Mojeek, Startpage, Yahoo and Wikipedia**. Bing and Yandex are listed in its README but disabled in that revision. Multiple requests and provider substitutions can occur; the exact recipients cannot be claimed until a dependency version is chosen and observed. [Selector](https://github.com/deedy5/ddgs/blob/70a5635510fb8d5b15d5ba6ceced6a67e212149b/ddgs/ddgs.py), [engine registry](https://github.com/deedy5/ddgs/blob/70a5635510fb8d5b15d5ba6ceced6a67e212149b/ddgs/engines/__init__.py). |
| Search infrastructure | DuckDuckGo says it temporarily sees IP/client information, retains anonymous queries and shields identifying information from its content partners. That policy covers DuckDuckGo traffic only, not other DDGS engines. Engine operators, their hosting/content providers and each engine's own policies remain relevant. Encrypted traffic conceals the query from ordinary network intermediaries, while destination/IP metadata remains visible. [DuckDuckGo privacy](https://duckduckgo.com/privacy). |
| Source-page requests | The search-only adapter does not fetch every result page. DDGS engines can make additional requests, such as Wikipedia's page-extract request. If a later lookup implementation fetches a publisher page directly, that publisher, its hosting provider and redirects receive the requested URL, public IP and request headers. A browser can additionally request scripts, images and trackers. DuckDuckGo privacy protections do not automatically apply to those visits. [Wikipedia engine source](https://github.com/deedy5/ddgs/blob/70a5635510fb8d5b15d5ba6ceced6a67e212149b/ddgs/engines/wikipedia.py), [external-site boundary](https://duckduckgo.com/privacy). |
| Brain request | The chosen brain receives the retained conversation, system context, tool descriptions and search results or fetched text included in the model request. A subscription cloud brain therefore sends that information to its model provider. At this research baseline, the LM Studio brain sent it to the Ally on the local network; the linked operation manual owns the current route. Search being free does not make cloud inference free or local. [Current prototype boundary](../../README.md#privacy-and-runtime-boundary), installed request assembly above. |

The installed search wrapper and DDGS adapter also log queries locally. This research did not inspect log contents. No microphone audio needs to leave the laptop for the recommended text-search route.

### Alternatives considered and rejected

| Route | Reason not chosen |
|---|---|
| Self-hosted SearXNG | Valid free metasearch alternative, already supported by Hermes, with no SearXNG per-query fee. It adds a service to install and maintain and still forwards queries to external engines. Public instances introduce another operator, availability limits and possibly disabled JSON responses. No evidence here that it improves this occasional prototype enough to justify that upkeep. [SearXNG project](https://docs.searxng.org/), [private-instance trade-offs](https://docs.searxng.org/own-instance.html). |
| Keyed Firecrawl, Tavily, Exa and Parallel | Useful search/extraction, but priced requests or credits exist. Limited free allocations can be used safely only with a proven hard stop and no paid balance path. Firecrawl expressly offers paid-plan pay-as-you-go when credits run out. Avoid relying on a provider's “free tier” label as that proof. [Firecrawl pricing](https://www.firecrawl.dev/pricing), [Tavily credits](https://docs.tavily.com/documentation/api-credits), [Exa pricing](https://exa.ai/pricing), [Parallel pricing](https://parallel.ai/pricing). |
| Hermes `brave-free` | The adapter's name does not establish today's terms. Brave now advertises Search at **$5 per 1,000 requests**, with **$5 free monthly credits**. That is a priced API with an allowance, not an unmetered route. [Brave pricing](https://brave.com/search/api/). This differs from scraping Brave's public search page through DDGS. |
| Current upstream anonymous free-provider ring or Tavily keyless | A real alternative, not necessarily billed: Tavily explicitly offers free, rate-limited keyless Search and Extract with no account. But installed Hermes's Tavily adapter requires a key, and installed selection lacks the current upstream anonymous ring. Using these newer paths would need an engine update or later integration, neither done here. [Tavily keyless terms](https://docs.tavily.com/documentation/keyless), [current Hermes backends](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search). |
| Subscription search, including Nous, OpenAI native and xAI | It can share a paid subscription's allowance, but introduces provider eligibility, credit consumption and potentially paid tool use. Installed Hermes has eight web providers, including xAI search through Grok OAuth or `XAI_API_KEY`; its API-key path is metered. Only OpenAI native search is absent from the installed providers. See the installed xAI source anchors above. Do not treat current documentation as installed functionality. [Hermes search backends](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search). |
| Purely local search/index | Local document search avoids an external search bill but cannot discover or refresh arbitrary current web sources without internet retrieval and an index. It does not meet the web-lookup outcome by itself. |

## Acceptance coverage and verification

| Card criterion | Evidence in this artifact |
|---|---|
| 15: accepted plans named with sources | Sign-in table separates implementation labels, current provider plans and permission gaps. |
| 15: allowance use described | Conversation/history/tool input and provider accounting sections. |
| 15: metered routes named | Billing-boundary table includes credits, API keys, auxiliary calls and tools. |
| 16: one no-per-use route named with evidence | DDGS recommendation, official DuckDuckGo cost/terms and explicit source inference. |
| 16: internet data stated | Request/recipient table includes engine routing, page requests and brain input. |
| 16: rejected routes and reasons listed | Alternatives table, including valid free alternatives and installed/upstream differences. |

Construction mode: evidence-required. Observer: reviewed official pages and published/installed source. Independent oracle: both issue briefs and provider-owned terms/source. Mechanical evidence: repository lint and document lint, run through the existing worklog runner. Fresh independent source review is the declared alternative to an executed mutation for this text-only claim. Slice specifications: not applicable; no executable behaviour was changed and no test pass count is claimed.
