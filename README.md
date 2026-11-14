# dsh-subproxy

一个 DSH 插件，把三种「订阅账号」当作 LLM 上游接进 Harness：

| 路由 | 上游 | 模型数 | 登录方式 |
| --- | --- | --- | --- |
| `sub-gpt` | OpenAI ChatGPT Plus/Pro（Codex 线路） | 9 | OAuth（浏览器 / 设备码） |
| `sub-claude` | Anthropic Claude Pro/Max | 17 | OAuth（浏览器） |
| `sub-gemini` | Google Antigravity（Cloud Code Assist） | 随账号目录（本人 Ultra 账号：12） | OAuth（浏览器） |

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
/subproxy                        # 三条路由的登录状态（含 Antigravity 的模型数与套餐）
/subproxy login sub-gemini       # 开始登录，打印授权链接
/subproxy login sub-gpt device   # 设备码：在任意设备输一串代码，全程不用粘贴
/subproxy code <粘贴>             # 把浏览器跳转后的地址（或 code）贴回来
/subproxy logout sub-gemini
```

**大多数情况你不需要跑这个。** 本机已有的登录态会被自动吸收（见下一节「登录拉取」）。
只有在机器上完全没有登录过、或者你要专门换一个号时，才需要这两条命令。

`login` 与 `code` 是两步，因为命令处理器只能返回一次结果，而 OAuth 要人去浏览器点。
两步之间插件的后台协程持有那个未答复的 prompt，`code` 把答案送回去，然后按真实结局
报成功或失败（`登录失败：invalid_grant: Malformed auth code.` 这类）。等链接时不再
死等固定的 1.2 秒 —— 授权地址一落地就返回，慢网络下也不会打印空结果。

**手机端**：登录时先看清浏览器在哪台机器上。

| 浏览器在哪 | 怎么收尾 |
| --- | --- |
| 手机自带浏览器（和引擎同一台机器） | 授权后会跳回 `http://localhost:<端口>/...`，loopback 就地接住，**自动完成，什么都不用做** |
| 另一台设备（在 PC 上打开手机给的链接） | 跳转到的 localhost 打不开，页面空白是正常的；把地址栏那一整串复制，`/subproxy code <粘贴>` 贴回来 |
| 想彻底不粘贴 | 只有 OpenAI 那条线支持：`/subproxy login sub-gpt device`，在任意设备打开 `auth.openai.com/codex/device` 输代码，插件轮询到即完成 |

三条线的回调端口不一样，但都不影响上面的判断：Antigravity 每次随机一个端口、
Claude 固定 `53692`、OpenAI 固定 `1455`。给 `device` 到不支持的线上会直接报错，
不会静默退化成浏览器授权。

凭据写在 `dsh-subproxy` 这个 credential scope 下，与宿主自带的 `llm-pi-ai` 完全隔离 ——
两家插件不会互相读到对方解析不了的记录。

## 登录拉取：账号自动吸收

这一条是不用做的。你在任何地方登录过 Google 账号，插件自己会把它收进来。

Antigravity IDE / `agy` / 各种上游工具把登录态写在 `~/.dsh/.credentials.yaml` 的
**`refs:`** 段（扁平 `KEY: <json>`），宿主自己的 `CredentialProvider` 只枚举 `records:`
段，所以那堆账号平时对任何插件都是隐形的。本插件做了两件事：

1. **扫描**：`readStoreRefs()` 自己解析 `refs:` 段，`grantOf()` 只认 Google 形状的
   （`scopes` 含 `googleapis.com` 或 access 以 `ya29.` 开头，且 refresh 齐全；PEM、
   没有 refresh、JSON 坏掉的一律跳过）。逐个拿 `loadCodeAssist` 探套餐档位，
   **按 `paidTier` 排名，不是 `currentTier`** —— Ultra 账号的 `currentTier.id` 经常就是
   `free-tier`，只看它会把这个号判成免费号。
2. **监视**：`watchStore()` 用 `fs.watch` 盯着凭据库所在**目录**（不是文件本身 ——
   宿主写库是 rename 替换，盯文件会随 inode 一起失效），400ms debounce。此后你在任何
   设备、任何客户端里登录或切换 Google 账号，最多十几秒后模型的档位就跟着变，不用重启。

吸收时有四条规则，都在 `preferAccount()` 这个纯函数里：

| 情况 | 行为 |
| --- | --- |
| 本插件还没有凭据 | 取排名最高的那个 |
| 你现在这个号是 `/subproxy login` 亲手登的 | **永不换号**（探档位只用来显示） |
| 扫出来的最强号和你正在用的是同一个 refresh token | 不重写（避免每次写库都白跑一轮） |
| 有更强的套餐（严格更高，不是同档） | 换成它，重建目录并让选择器立刻刷新 |

「亲手登的」怎么识别：插件吸收时是把 grant **复制**成 `records: dsh-subproxy/sub-gemini`，
而 `/subproxy login` 走 pi-ai 写自己那条 record、**不动 `refs:`**。所以「当前 refresh token
在 `refs:` 里找不到」就一定是人登的 —— 这个判断跨重启仍然成立，不是内存里的一个开关。

Windows 上有个必须记住的坑：`fs.watch` 用 8.3 短名（`C:\Users\ADMINI~1\...`）起监视、
却在事件里回报长名，libuv 的断言直接 `abort()` 整个进程
（`Assertion failed: !_wcsnicmp(filename, dir, dirlen), src\win\fs-event.c`）。
`canonicalDirectory()` 先用 `realpathSync.native` 规范化再 watch，就是为了这个。

所以：本机已经登录过 Antigravity 的话，装完就有模型；手机上的引擎只要和登录态在同一个
`~/.dsh` 里，也同样自动可用。

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
node test/wiring.mjs             # 28 项：三条路由注册、目录、档位、登录流、命令、账号吸收、watcher、dispose
node test/host-contract.mjs      # 16 项：过真实 PiAiAdapter，验 harness chunk 契约
```

`wiring` 那一套跑在临时目录里的假凭据库上（`DSH_CREDENTIALS_FILE` 指到
`mkdtemp` 出来的文件），不会去看你真实登录了什么 —— 否则你在跑测试期间切一下号就能把
测试搞红。它覆盖了吸收的四条规则、watcher 被写库唤醒、`dispose` 之后 watcher 停下、
以及凭据库的目录还不存在时不会炸。

`antigravity-lane` 把 `fetch` 换成 fixture 路由，整条请求链路（翻译 → 序列化 → 解帧 → pi-ai 事件）
跑的是真实代码，只是上游是假的。`host-contract` 不用 mock，直接拿宿主的 `PiAiAdapter`
跑 `prepareCall`/`stream`，验的是 chunk 形状（`finish.reason` 是对象不是字符串、usage 字段是
`inputTokens`/`outputTokens`、错误走 `error` 事件而不是抛异常），不是我们自己以为的契约。

## 风险

Google 与 Anthropic 都不支持把订阅额度用在第三方客户端上，OpenAI 同理。这三条线路都是
「让官方客户端协议跑在别处」，账号有被风控的可能 —— 这不是本插件能解决的问题。
多号轮换只能摊薄单号被封的损失，不能防封。
