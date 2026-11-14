# dsh-subproxy

一个 DSH 插件，把三种「订阅账号」当作 LLM 上游接进 Harness：

| 路由 | 上游 | 模型数 | 登录方式 |
| --- | --- | --- | --- |
| `sub-gpt` | OpenAI ChatGPT Plus/Pro（Codex 线路） | 9 | OAuth |
| `sub-claude` | Anthropic Claude Pro/Max | 17 | OAuth |
| `sub-gemini` | Google Antigravity（Cloud Code Assist） | 随账号目录（本人 Ultra 账号：12） | OAuth |

反代的意思很直白：不用 API key、不按 token 计费，用的是你已经付过钱的订阅额度。
所以 `GET /models` 里这些模型的价格一律记 0 —— 不是漏填，是这套额度本来就不按 token 卖。

## 装

从 GitHub 直接装（手机、PC 同一条命令，换 profile 名即可）：

```bash
# PC
dsh plugin --profile desktop add github:AEmbers/dsh-subproxy

# 手机（DSH GO 的本机引擎用 web profile）
dsh plugin --profile web add github:AEmbers/dsh-subproxy
```

本机开发时用路径链接：

```bash
dsh plugin --profile desktop add C:\Sophia\dev-plugin\dsh-subproxy
```

装完重启宿主，模型选择器里会出现三个以「订阅 ·」开头的 provider（实测
`session/modelCatalog` 的 `routableProviders` 里就是 `sub-gpt`/`sub-claude`/`sub-gemini`）。

这个仓库零原生依赖、零构建步骤：`lib/` 下全是可直接 import 的 ESM，`node_modules/`
只在你本地跑测试时存在（用 junction 指向宿主解析出来的包），不会进 git、也不进 `files`。
所以手机上不需要 agy 二进制、不需要 gcc、不需要 pnpm 之外的任何东西。

## 登录：`/subproxy` 命令

登录入口是**斜杠命令**，不是设置页按钮 —— 这不是偷懒。宿主的 Web 与手机前端
在整张 RPC 表里只有 `authorization/settled` 一个事件，没有任何 `authorization/*`
调用端点，所以 `ctx.authorization.registerFlow()` 注册的登录流在 Web/手机上**没有
任何渲染面**（只有 Electron 的桌面 UI 会用）。命令是所有前端都会渲染的那一个面。

```text
/subproxy                  # 三条路由的登录状态（含 Antigravity 的模型数与套餐）
/subproxy login sub-gemini # 开始登录，打印授权链接
/subproxy code <粘贴>       # 把浏览器跳转后的地址（或 code）贴回来
/subproxy logout sub-gemini
```

`login` 与 `code` 是两步，因为命令处理器只能返回一次结果，而 OAuth 要人去浏览器点。
两步之间插件的后台协程持有那个未答复的 prompt，`code` 把答案送回去，然后按真实结局
报成功或失败（`登录失败：invalid_grant: Malformed auth code.` 这类）。

**手机端**：手机浏览器无法回调到 DSH 进程，所以三个流程都保留「粘贴」通道 ——
浏览器授权后会跳到一个 `http://localhost:<随机端口>/oauth-callback?code=...` 的地址
（页面打不开是正常的），把地址栏那一整串贴回来即可。插件会先尝试在本机起 loopback
监听；起不来就用粘贴，两条路是 `Promise.race`，谁先到用谁。

凭据写在 `dsh-subproxy` 这个 credential scope 下，与宿主自带的 `llm-pi-ai` 完全隔离 ——
两家插件不会互相读到对方解析不了的记录。

### 不用登录也能用上本机已有的 Google 账号

Antigravity IDE / `agy` 把登录态写在 `~/.dsh/.credentials.yaml` 的 **`refs:`** 段
（不是 `records:` 段）。宿主的 `CredentialProvider` 只枚举 `records:`，所以插件平时
看不见它们。冷启动时插件会自己扫一遍 `refs:`，逐个拿 `loadCodeAssist` 探档位，按套餐
从高到低排，**采纳最强那个**写进自己的 record。所以本机已经登录过 Antigravity 的话，
装完就有模型，不用再登一次。

已有属于本插件自己的凭据时**不会换号**——只探档位用来显示，绝不把路由悄悄切给别的账号。

## 模型为什么会「少」

Antigravity 的模型目录由服务端按账号套餐下发，插件只是如实呈现。同一条线路：

- 免费 / Pro 账号：`gemini-4-carbon|argon|hydrogen` 是 `disabled: true`，上游对它们的
  所有 tier 都回 `404 Requested entity was not found`。
- Ultra 账号：这三个全开，另加 `claude-opus-5-5` / `claude-sonnet-5-5` 各 low/medium/high。

因为列出来只会产生一轮注定失败的请求，`disabled` 的模型**不进选择器**，只记一条日志：

```
[dsh-subproxy] N 个 Antigravity 模型当前账号档位不可用，已隐藏（升级 Google AI 套餐后自动出现）
```

`/subproxy` 会直接写出真相，例如
`已登录，12 个可用模型，套餐 Google AI Ultra`。
`loadCodeAssist` 的 `currentTier.id` 即使是付费号也常常报 `free-tier`，所以插件显示的是
`paidTier.id` 翻译后的套餐名，不是那个内部 id。

想单独核对（不启动宿主）：

```bash
node verify-catalog.mjs   # 本机所有 Google 账号的套餐、采纳哪一个、上游每个模型与档位阶梯
node verify-stream.mjs gemini-4-carbon claude-opus-5-5   # 直接发一次真实请求，验模型 id 通不通
```

`verify-catalog` 只列目录，`verify-stream` 才是端到端：它走 `buildProviders()` 拿到与宿主
完全相同的 provider 对象，发一轮真请求，把 SSE 帧解成文本打出来。目录里有的 id 未必服务
（曾被 404 打回过），这一步能立刻分辨。

## 路由 id 为什么叫 `sub-*`

宿主自带的 `llm-pi-ai` 插件已经会注册 `openai-codex` 和 `anthropic` 这两个 route id。
`registerAdapter` 是全有全无的：一个 route 撞车就抛 `DUPLICATE_ADAPTER`，整批注册一起作废。
`sub-` 前缀把两个插件彻底隔开。三条路由各自独立注册，真撞了一条也只损失那一条。

## Antigravity 那条线

Cloud Code Assist 不属于 pi-ai 的十种 `KnownApi` 协议里的任何一种，所以这条线路是手写的，
照 `xdpool` 的 gemini 通道逐行对齐：

- `daily-cloudcode-pa.googleapis.com` / `...sandbox.googleapis.com` 双端点，403/404/429 自动切换。
- 请求体**按 key 字母序递归序列化**（`marshalAlphabetical`）—— 上游对指纹敏感，成员顺序是线协议的一部分。
- 身份五头：`x-client-name: antigravity`、`x-client-version: 2.40.0`、`x-machine-id: cmdc-pak`、
  `x-vscode-sessionid: proxy`、`User-Agent: antigravity/hub/2.40.0 win32/x64`。
- 工具 id 不合 `^[a-zA-Z0-9_-]{1,64}$` 就重编号，`functionCall` 与 `functionResponse` 必须配同一套。
- 工具 schema 要清洗：`required: true` 提升到父级、元组 `items` 只留首个、`anyOf` 展平成对象。
- assistant 的历史轮次里 `thinking` 块只丢内容保留 `thoughtSignature`，挂到 toolCall 上带回去。
- 档位（tier）有五个：`low`/`medium`/`high`/`xhigh`/`tiered`。`xhigh` 只有 Gemini 4 Hydrogen
  服务；模型不服务的档位必须显式 `null` 隐藏，否则 harness 会以为支持然后静默降档。
- 失败阶梯：签名失效 → 丢签名重试；session 溢出 → 换 generation；401 → 刷一次 token；
  429/额度 → 换端点。额度类错误映射成 `QUOTA_EXCEEDED`（不在可重试码表里），
  否则 harness 会白等五轮退避。

## 测试

三套离线测试，不联网、不碰宿主：

```bash
node test/antigravity-lane.mjs   # 30 项：schema 清洗、目录解析、账号排名、id 重编号、SSE 解帧、失败阶梯
node test/wiring.mjs             # 21 项：三条路由注册、目录、档位、登录流、命令、dispose
node test/host-contract.mjs      # 16 项：过真实 PiAiAdapter，验 harness chunk 契约
```

`antigravity-lane` 把 `fetch` 换成 fixture 路由，整条请求链路（翻译 → 序列化 → 解帧 → pi-ai 事件）
跑的是真实代码，只是上游是假的。`host-contract` 不用 mock，直接拿宿主的 `PiAiAdapter`
跑 `prepareCall`/`stream`，验的是 chunk 形状（`finish.reason` 是对象不是字符串、usage 字段是
`inputTokens`/`outputTokens`、错误走 `error` 事件而不是抛异常），不是我们自己以为的契约。

## 风险

Google 与 Anthropic 都不支持把订阅额度用在第三方客户端上，OpenAI 同理。这三条线路都是
「让官方客户端协议跑在别处」，账号有被风控的可能 —— 这不是本插件能解决的问题。
多号轮换只能摊薄单号被封的损失，不能防封。
