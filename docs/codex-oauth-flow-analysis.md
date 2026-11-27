# OpenAI / Codex OAuth 抓包链路与状态流转分析

> **整理依据**：三轮完整手动抓包记录 + [临期轮转开车接口与链路总览-2026年9月18日-abai.docx](../临期轮转开车接口与链路总览-2026年9月18日-abai.docx) 第 2 章节（OAuth）+ `vm2api` 现有 OAuth 模块代码。
>
> **全量请求与参数明细**：[codex-oauth-captured-requests.md](./codex-oauth-captured-requests.md)（按时序收录全部 19 个请求的 URL、Query、Headers、Cookies、Body、Response 与字段字典）
>
> **脱敏说明**：本文档已将抓包中的真实邮箱、密码、IP、Cookie、JWT、`sessionToken`、一次性授权码与账户/组织 ID 全部替换为占位符（如 `<email>`、`<workspace_id>`）。如原抓包来自真实账号，建议尽快修改密码并注销对应会话（`/api/auth/session` 返回的 `accessToken` 与 `sessionToken` 属于高敏凭据）。

---

## 1. 核心结论速览

三轮抓包已经把**浏览器侧能看到的全部关键 HTTP 请求基本补齐**。整个过程实际上由**两个不同 `client_id` 的独立 OAuth 流程**拼在一起：

| 维度 | 第一段：ChatGPT Web 登录 | 第二段：Codex Desktop OAuth |
| :--- | :--- | :--- |
| **`client_id`** | `app_X8zY6vW2pQ9tR3dE7nK1jL5gH` | `app_EMoamEEZ73f0CkXaXp7hrann` |
| **`app_name_enum`** | `chat` | `oaicli` |
| **`redirect_uri`** | `https://chatgpt.com/api/auth/callback/openai` | `http://localhost:1455/auth/callback` |
| **会话 ID 格式** | `authsess_bh_*` | `authsess_*` |
| **最终产物** | 网页版 NextAuth 会话 + `auth.openai.com` 统一会话（`us_*`） | Codex 授权码 `code` → 由本地/`vm2api` 换取 `access_token` / `refresh_token` / `id_token` |
| **抓包完整度** | **100% 闭环**（从 `/api/auth/csrf` 到 `/api/auth/session` 全齐） | 浏览器侧仅缺第 2 段 `workspace/select` 响应体及后续 302；最终 `POST /oauth/token` 由本地服务端发出，浏览器 Network 里不会出现 |

### 两个重要机制澄清（解释为什么 Network 里看不到某些请求）

1. **为什么看不到 `GET /mfa-challenge/...`、`GET /workspace`、`GET /codex/consent`？**
   - 从三轮抓包第 10 项（`manifest-*.js` 的 `window.__reactRouterManifest`）可以确认，`auth.openai.com` 是 **React Router 单页应用（SPA）**。
   - 当接口返回的 `continue_url` 仍在 `auth.openai.com` 同域内（如 `email-verification`、`mfa-challenge`、`workspace`、`codex/consent`）时，前端直接用响应体里的 `oai-client-auth-session` 在客户端切换路由，**不会向服务端发出新的页面 `GET` 请求**。
   - 只有当响应为 `page.type="external_url"`（跨域跳转回 `chatgpt.com/api/auth/callback/openai` 或 `http://localhost:1455/auth/callback`）时，浏览器才会发出真正的整页 `GET` 导航。
2. **为什么看不到最后一步 `POST https://auth.openai.com/oauth/token`？**
   - 因为当浏览器跳到 `http://localhost:1455/auth/callback?code=...&state=...` 时，浏览器侧任务就结束了；最后的换票请求由**本地客户端 / `vm2api` 后端**拿着 `code` 和本地保存的 `code_verifier` 发送，因此不会出现在浏览器 Network 面板中。

---

## 2. 完整抓包还原流程图（三轮汇总）

图例标注：`[上1~9]` = 第一轮抓包，`[补1~4]` = 第二轮抓包，`[三1~10]` = 第三轮抓包。

```mermaid
flowchart TD
    subgraph S1["第一段：ChatGPT Web 登录 (client_id = app_X8zY6v...，已全量抓齐)"]
        A0["[三1] GET chatgpt.com/api/auth/csrf (获取 csrfToken)"]
        A1["[补1] POST chatgpt.com/api/auth/signin/openai (生成 authorize URL + NextAuth PKCE Cookie)"]
        A2["[三2] GET auth.openai.com/oauth/authorize (初始化 authsess_bh_* , ws=0)"]
        A3["[补2] GET /api/accounts/client_auth_session_dump (读取初始会话状态, ws=0)"]
        A4["[三3] POST /api/accounts/passwordless/send-otp (返回 email_otp_verification 与可选方式 password)"]
        A4b["[SPA前端路由] 切到密码登录页 (同域无整页 GET)"]
        A5["[上1] POST /api/accounts/password/verify (校验密码 -> 返回 factor_id 与新 auth_page)"]
        A6["[SPA前端路由] 切到 /mfa-challenge (同域无整页 GET)"]
        A7["[上2] POST /api/accounts/mfa/verify (校验 6 位 TOTP -> 返回 workspaces 列表)"]
        A8["[SPA前端路由] 切到 /workspace (同域无整页 GET)"]
        A9["[补3] GET /api/accounts/client_auth_session_dump (读取含 workspaces 的状态, ws=4)"]
        A10["[补4] POST /api/accounts/workspace/select (选工作区 -> 返回 external_url 回调)"]
        A11["[三6] GET chatgpt.com/api/auth/callback/openai?code=... (换票写入网页 Session + 统一会话 us_*)"]
        A12["[三7] GET chatgpt.com/api/auth/session (返回网页版 accessToken / account / user)"]
        A13["[上3~5 冗余] GET/PATCH chatgpt.com/backend-api/.../onboarding_answers (网页新手引导)"]

        A0 --> A1 --> A2 --> A3 --> A4 --> A4b --> A5 --> A6 --> A7 --> A8 --> A9 --> A10 --> A11 --> A12
        A12 -.-> A13
    end

    H["跨应用交接：auth.openai.com 已写入 __Host-unified_session_manifest (us_*) 与 __Host-usc_*"]
    A11 --> H

    subgraph S2["第二段：Codex Desktop OAuth (client_id = app_EMoamEEZ...)"]
        B1["[上6 / 三8] GET chatgpt.com/codex/desktop-auth?authorize_url=... (带 code_challenge / state / offline_access)"]
        B2["[三9] GET auth.openai.com/oauth/authorize?...&prompt=select_account (新建 authsess_* , 读到 us_*)"]
        B3["[上7] POST /api/accounts/session/select (提交 session_id=us_* 复用第一段登录态)"]
        B4["[SPA前端路由] 切到 /sign-in-with-chatgpt/codex/consent (同域无整页 GET)"]
        B5["[上8] POST /api/accounts/workspace/select (提交 workspace_id，未贴响应体)"]
        B6["[未贴] 跟随响应的 continue_url / 302 跳转链"]
        B7["[上9] 落地 http://localhost:1455/auth/callback?code=ac.1.*&state=* (获得一次性授权码)"]
        B8["[本地后端发出] POST auth.openai.com/oauth/token (code + code_verifier 换票)"]
        B9["获得最终凭据：access_token + refresh_token + id_token"]

        B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7 --> B8 --> B9
    end

    H --> B2

    subgraph S3["后续长期维护（标准 OAuth 续期）"]
        C1["access_token 即将过期 / 401"]
        C2["POST auth.openai.com/oauth/token (grant_type=refresh_token)"]
        C3["刷新 access_token / refresh_token（无需重走登录页）"]
        C1 --> C2 --> C3
    end

    B9 --> C1

    style A4b fill:#e7f3ff,stroke:#3b82f6
    style A6 fill:#e7f3ff,stroke:#3b82f6
    style A8 fill:#e7f3ff,stroke:#3b82f6
    style B4 fill:#e7f3ff,stroke:#3b82f6
    style B6 fill:#fff3cd,stroke:#d39e00
    style B8 fill:#f8d7da,stroke:#dc3545
    style A13 fill:#e2e3e5,stroke:#6c757d
    style B9 fill:#d4edda,stroke:#28a745
    style C3 fill:#d4edda,stroke:#28a745
```

> **图例说明**：
> - **浅蓝色**：React Router SPA 客户端内部切换（同域不产生整页 HTTP `GET`，所以 Network 里看不到，对应 `[三10]` 抓到的路由清单）；
> - **浅黄色**：第二段 `workspace/select` 之后未贴出的响应/跳转；
> - **浅红色**：由本地/`vm2api` 后端发出的最终换票请求（浏览器里本身看不到）；
> - **浅灰色**：网页新手引导，与 Codex OAuth 无关；
> - **浅绿色**：最终凭据产出与长期自动续期。

---

## 3. 精简版标准主线流程图（去掉冗余 Web 登录）

如果直接从干净会话打开 Codex 授权链接，**第一段 ChatGPT Web 登录、`session/select` 和 `onboarding_answers` 都可以省略**，整体收敛为 3 步首次授权 + 长期自动续期：

```mermaid
flowchart LR
    P1["1. 本地生成 PKCE 与授权链接 (code_verifier / code_challenge / state)"]
    P2["2. 可见浏览器完成交互授权 (密码 + 2FA + 选工作区)"]
    P3["3. 回调 localhost:1455 截获 code 并校验 state"]
    P4["4. 本地后端 POST /oauth/token 换取 AT / RT / ID Token"]
    P5["5. 到期自动 POST /oauth/token (grant_type=refresh_token)"]

    P1 --> P2 --> P3 --> P4 --> P5
    P5 -.->|"下次到期循环续期"| P5
```

---

## 4. 四方交互时序图（完整两段实测版）

```mermaid
sequenceDiagram
    participant Local as 本地 / vm2api
    participant Browser as 浏览器 (含 React Router SPA)
    participant Chat as chatgpt.com
    participant Auth as auth.openai.com

    Note over Browser,Auth: 第一段：ChatGPT Web 登录 (app_X8zY6v...)
    Browser->>Chat: [三1] GET /api/auth/csrf
    Chat-->>Browser: csrfToken
    Browser->>Chat: [补1] POST /api/auth/signin/openai
    Chat-->>Browser: auth.openai.com/oauth/authorize URL + PKCE Cookie
    Browser->>Auth: [三2] GET /oauth/authorize (初始化 authsess_bh_*)
    Auth-->>Browser: SPA 页面 + auth-session-minimized (ws=0)
    Browser->>Auth: [补2] GET /api/accounts/client_auth_session_dump
    Browser->>Auth: [三3] POST /api/accounts/passwordless/send-otp
    Auth-->>Browser: login_methods = [passwordless_otp, password]
    Note over Browser: SPA 切到密码登录页，用户输入密码
    Browser->>Auth: [上1] POST /api/accounts/password/verify
    Auth-->>Browser: mfa_challenge (factor_id + 新 auth_page)
    Note over Browser: SPA 切到 /mfa-challenge (无 HTTP GET)
    Browser->>Auth: [上2] POST /api/accounts/mfa/verify (TOTP)
    Auth-->>Browser: workspace 列表
    Note over Browser: SPA 切到 /workspace (无 HTTP GET)
    Browser->>Auth: [补3] GET /api/accounts/client_auth_session_dump (ws=4)
    Browser->>Auth: [补4] POST /api/accounts/workspace/select
    Auth-->>Browser: external_url = chatgpt.com/api/auth/callback/openai?code=...
    Browser->>Chat: [三6] GET /api/auth/callback/openai?code=...
    Chat-->>Browser: 写入 __Secure-next-auth.session-token (同时 Auth 已种下 us_*)
    Browser->>Chat: [三7] GET /api/auth/session
    Chat-->>Browser: 返回 Web accessToken / account / user

    Note over Local,Auth: 第二段：Codex Desktop OAuth (app_EMoamEEZ...)
    Local->>Local: 生成 state / code_verifier / code_challenge
    Local->>Browser: [上6] 打开 chatgpt.com/codex/desktop-auth?authorize_url=...
    Browser->>Chat: [三8] GET /codex/desktop-auth?authorize_url=...
    Chat-->>Browser: 302 到 auth.openai.com/oauth/authorize?...&prompt=select_account
    Browser->>Auth: [三9] GET /oauth/authorize (携带统一会话 us_*)
    Browser->>Auth: [上7] POST /api/accounts/session/select (session_id=us_*)
    Auth-->>Browser: sign_in_with_chatgpt_codex_consent + workspaces
    Note over Browser: SPA 切到 /codex/consent (无 HTTP GET)
    Browser->>Auth: [上8] POST /api/accounts/workspace/select (workspace_id)
    Auth-->>Browser: continue_url -> 302 回调链
    Auth-->>Browser: [上9] 302 http://localhost:1455/auth/callback?code=ac.1.*&state=*
    Browser->>Local: 回调 / 粘贴 code 与 state
    Local->>Auth: POST /oauth/token (grant_type=authorization_code, code, code_verifier)
    Auth-->>Local: access_token + refresh_token + id_token
```

---

## 5. 分步请求明细对照表（三轮完整归位）

### 5.1 第一段：ChatGPT Web 登录（`app_X8zY6vW2pQ9tR3dE7nK1jL5gH`，已完整）

| 顺序 | 抓包编号 | 状态 | Method & URL | 关键输入 / 输出与说明 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 三 1 | 已截 | `GET https://chatgpt.com/api/auth/csrf` | 返回 `{"csrfToken":"..."}`，对应 Cookie `__Host-next-auth.csrf-token`。 |
| 2 | 补 1 | 已截 | `POST https://chatgpt.com/api/auth/signin/openai?...` | 提交 `csrfToken`、`callbackUrl`、`json=true`，返回 `auth.openai.com/oauth/authorize` 链接，并写入 `__Secure-next-auth.state` 与 `__Secure-next-auth.pkce.code_verifier`。 |
| 3 | 三 2 | 已截 | `GET https://auth.openai.com/oauth/authorize?...` | 浏览器整页导航到 `auth.openai.com`，加载 React Router SPA（`[三10]` `manifest-*.js`），初始化 `auth-session-minimized`（`ws=0`）与 `__Host-oai-initial-email-page`。 |
| 4 | 补 2 | 已截 | `GET https://auth.openai.com/api/accounts/client_auth_session_dump` | 只读接口，拉取 `ws=0` 时的初始会话快照（已带入 `email`，`passwordless_email_otp_send_pending: true`）。 |
| 5 | 三 3 | 已截 | `POST https://auth.openai.com/api/accounts/passwordless/send-otp` | 空 body（`content-length: 0`）；返回 `email_otp_verification` 页数据，其中 `login_methods` 列出 `passwordless_otp` 与 `password`，前端据此展示「改用密码登录」入口。 |
| 6 | 上 1 | 已截 | `POST https://auth.openai.com/api/accounts/password/verify` | 提交 `{"password":"<password>"}`，返回 `page.type="mfa_challenge"`、`factor_id` 与新 `auth_page`（前端 SPA 直接切页，不发整页 `GET`）。 |
| 7 | 上 2 | 已截 | `POST https://auth.openai.com/api/accounts/mfa/verify` | 提交 `{"id":"<factor_id>","type":"totp","code":"<6位码>"}`，头里带新 `openai-auth-page`；返回 `page.type="workspace"` 和工作区列表（前端 SPA 直接切页，不发整页 `GET`）。 |
| 8 | 补 3 | 已截 | `GET https://auth.openai.com/api/accounts/client_auth_session_dump` | 只读接口，拉取 `ws=4` 时的已认证会话快照（含 `mfa_factors`、`name`、`workspaces`）。 |
| 9 | 补 4 | 已截 | `POST https://auth.openai.com/api/accounts/workspace/select` | 提交 `{"workspace_id":"<workspace_id>"}`，返回 `page.type="external_url"` 及 `continue_url=https://chatgpt.com/api/auth/callback/openai?code=...&state=...`。 |
| 10 | 三 6 | 已截 | `GET https://chatgpt.com/api/auth/callback/openai?code=...&state=...` | 跨域整页导航回到 `chatgpt.com`，NextAuth 服务端用 `pkce.code_verifier` 换票并种下 `__Secure-next-auth.session-token.*`；同时 `auth.openai.com` 已落盘统一会话 `__Host-unified_session_manifest`（`us_*`）与 `__Host-usc_*`。 |
| 11 | 三 7 | 已截 | `GET https://chatgpt.com/api/auth/session` | 返回网页版会话 JSON（含 Web `accessToken`、`account`、`user`、`sessionToken`）。 |
| 12 | 上 3~5 | 冗余 | `GET / PATCH https://chatgpt.com/backend-api/accounts/<ws>/users/<uid>/onboarding_answers` | 网页首次进入工作区的引导问卷/资料接口，与拿 Codex Token 无关。 |

### 5.2 第二段：Codex Desktop OAuth（`app_EMoamEEZ73f0CkXaXp7hrann`）

| 顺序 | 抓包编号 | 状态 | Method & URL | 关键输入 / 输出与说明 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 上 6 / 三 8 | 已截 | `GET https://chatgpt.com/codex/desktop-auth?authorize_url=...` | 授权入口 URL，内层为 `auth.openai.com/oauth/authorize`，包含 `client_id=app_EMoamEEZ73f0CkXaXp7hrann`、`redirect_uri=http://localhost:1455/auth/callback`、`scope`（含 `offline_access`）、`code_challenge`（S256）与 `state`。 |
| 2 | 三 9 | 已截 | `GET https://auth.openai.com/oauth/authorize?...&prompt=select_account&codex_streamlined_login=true&screen_hint=login_or_signup` | `desktop-auth` 自动补上 `prompt=select_account` 等参数后重定向到此；携带第一段留下的 `__Host-unified_session_manifest`（`us_*`）与 `__Host-usc_*`，创建新会话 `authsess_*`（`ws=0`）。 |
| 3 | 上 7 | 已截 | `POST https://auth.openai.com/api/accounts/session/select` | 提交 `{"session_id":"us_*"}`，返回 `page.type="sign_in_with_chatgpt_codex_consent"` 与可选 `workspaces` 列表（前端 SPA 直接切到 `/codex/consent`）。 |
| 4 | 上 8 | 仅缺响应体 | `POST https://auth.openai.com/api/accounts/workspace/select` | 提交 `{"workspace_id":"<workspace_id>"}`（未贴响应体，正常返回指向回调重定向链的 `continue_url`）。 |
| 5 | — | 未贴 | 跟随 `continue_url` 与 302 重定向链 | 沿 `Location` 跳至本地回调（文档 2.2 ② 标注上限 12 跳；停在 `/email-verification` 表示会话失效，停在 `/add-phone` 表示触发绑手机门禁）。 |
| 6 | 上 9 | 已截 | `http://localhost:1455/auth/callback?code=ac.1.*&scope=...&state=...&iss=...` | 浏览器最终落地地址，携带一次性授权码 `code` 与 `state`。 |
| 7 | — | **本地后端发出** | `POST https://auth.openai.com/oauth/token` | 浏览器不发此请求，由本地/`vm2api` 以 `application/x-www-form-urlencoded` 提交 `grant_type=authorization_code` + `client_id` + `code` + `redirect_uri` + `code_verifier`，换出最终 `access_token`、`refresh_token`、`id_token`。 |

---

## 6. 核心参数与状态接力说明

| 参数 / Cookie | 产生位置 | 消费位置 | 协议作用 |
| :--- | :--- | :--- | :--- |
| **`code_verifier` / `code_challenge` / `state`** | 本地生成第 6 步授权链接时 | `code_challenge` 放在授权 URL；`state` 在回调校验；`code_verifier` 在 `/oauth/token` 提交 | 标准 OAuth 2.0 PKCE。`code_challenge = base64url(sha256(code_verifier))`，回调拿到的 `code` 必须与同一次本地会话保存的 `code_verifier` 配对换票。 |
| **`auth-session-minimized` 与 `...-client-checksum`** | `auth.openai.com` 每步响应 `Set-Cookie` | 后续每步 `auth.openai.com/api/accounts/*` | 服务端签名的状态机凭据，内含递增的写序号 `ws`（如 `0 → 1 → 3 → 4`）与校验和，旧值不能跨步复用。 |
| **`openai-auth-page`** | 初始来自 `__Host-oai-initial-email-page`，每步接口响应 `continue_url` 中 `?auth_page=...` 刷新 | 下一步 `POST` 请求头 `openai-auth-page` | 步骤/页面防重放令牌，每次切页都会轮换。 |
| **`factor_id` 与 `workspace_id`** | `password/verify` 返回 `factor_id`；`mfa/verify` / `client_auth_session_dump` / `session/select` 返回 `workspaces` | `mfa/verify` body 中的 `id`；`workspace/select` body 中的 `workspace_id` | 指定 2FA 校验因子与最终签发 Token 归属的团队/个人空间。 |
| **`__Host-unified_session_manifest`（`us_*`）与 `__Host-usc_*`** | 第一段登录完成后写入 `auth.openai.com` | 第二段 `[三9]` 带入并在 `[上7]` `session/select` 提交 `session_id` | 跨客户端复用的统一登录态；存在时可跳过重复密码与 2FA。 |
| **`code`（`ac.1.*`）** | `[上9]` 回调查询参数 | `POST https://auth.openai.com/oauth/token` | 一次性短时授权码，换票后失效。 |

---

## 7. 与 `vm2api` 现有代码及文档第 2 章的映射

| 环节 | 文档第 2 章对应 | `vm2api` 已有实现 | 当前状态 |
| :--- | :--- | :--- | :--- |
| 生成 Codex PKCE 与授权链接（`上6` / `三8`） | 2.2 ① | [src/lib/oauth/codex-oauth.mjs](../src/lib/oauth/codex-oauth.mjs)（`generateCodexAuthUrl`、`deriveCodexSurfaceStableId`） | 已实现（会话 TTL 10 分钟） |
| 解析回调 URL 并用 `code` 换票（`上9` → `POST /oauth/token`） | 2.2 ②③ | [src/lib/oauth/codex-oauth.mjs](../src/lib/oauth/codex-oauth.mjs)（`exchangeCodexAuthCode`）→ [src/lib/protocol/codex-models.mjs](../src/lib/protocol/codex-models.mjs)（`exchangeCodexAuthorizationCode`） | 已实现（当前需手动粘贴回调 URL） |
| JWT 身份与订阅字段解析 | 4.1 / 4.2 | [src/lib/oauth/openai-jwt.mjs](../src/lib/oauth/openai-jwt.mjs)（`openaiIdentityFromOauthTokens`、`openaiClaimsFromIdToken`） | 已实现 |
| `refresh_token` 续期与失效巡检 | 2.2 ③（`offline_access`） | [src/lib/protocol/codex-models.mjs](../src/lib/protocol/codex-models.mjs)（`refreshCodexAccessToken`）+ [src/lib/oauth/codex-login-guard.mjs](../src/lib/oauth/codex-login-guard.mjs) + [src/lib/oauth/codex-login-runtime.mjs](../src/lib/oauth/codex-login-runtime.mjs) | 已实现 |
| 重登队列、防串号与熔断控制 | 3.8 | [src/lib/oauth/codex-relogin.mjs](../src/lib/oauth/codex-relogin.mjs) | 已实现 |
| 外部登录服务协议接入与管理路由 | 2.1 / 2.3 | [src/lib/oauth/codex-login-service.mjs](../src/lib/oauth/codex-login-service.mjs) + [src/lib/admin/codex-login-routes.mjs](../src/lib/admin/codex-login-routes.mjs) | 已预留标准接口适配（不含本地网页登录逻辑） |

---

## 8. 协议细节与高频踩坑清单（容易忽略的关键点）

### 8.1 请求头与客户端身份一致性

1. **授权页（Desktop 封装版 vs CLI 直连版）差异**：
   - `vm2api`（[codex-oauth.mjs](../src/lib/oauth/codex-oauth.mjs)）走的是 **Codex Desktop 封装形态**：外层 `https://chatgpt.com/codex/desktop-auth?authorize_url=...&codex_streamlined_login=true&no_universal_links=1`，内层带 `originator=Codex Desktop`、`codex_app_version=0.170.0`、`source_surface_stable_id` 与 `codex_origin_stable_id`（由安装 ID 经 SHA-256 确定性派生的 UUID v4）。
   - 原文档 2.2 记录的是 **Codex CLI 直连形态**：直接请求 `https://auth.openai.com/oauth/authorize`，`originator=codex_cli_rs`，不套 `desktop-auth`。
   - 实测（三轮第 9 条）显示：`desktop-auth` 重定向到 `auth.openai.com/oauth/authorize` 时会自动追加 `prompt=select_account` 和 `screen_hint=login_or_signup`。
2. **`Originator` 必须与 `User-Agent` 前缀匹配**：
   - 模型目录（`GET /backend-api/codex/models`）与用量接口（`GET /backend-api/wham/usage`）会校验 `Originator` 与 `User-Agent` 前缀一致（见 [codex-models.mjs](../src/lib/protocol/codex-models.mjs) 注释）：如 `originator: codex_cli_rs` 搭配 `user-agent: codex_cli_rs/<ver> (linux x86_64)` 与 `version: <ver>`。
   - `/oauth/token` 换票与刷新必须使用 `Content-Type: application/x-www-form-urlencoded`（不是 JSON）。
3. **团队空间请求必带 `chatgpt-account-id`**：
   - 团队/组织接口的请求头 `chatgpt-account-id: <workspace_id>` 必须与 URL 中的 `account_id` 以及当前空间一致；缺失该头或缺少浏览器语义头（`Origin` / `Referer` / `Sec-Fetch-*` / `oai-device-id` / `oai-language`）容易被直接拦截返回 `403` HTML。
4. **不要混用两类客户端及两类空间的 Access Token**：
   - ChatGPT Web（`app_X8zY6v...`）的 `accessToken` 与 Codex OAuth（`app_EMoamEEZ...`）的 `access_token` 属于不同客户端，scope 和续期路径都不同。
   - 同一账号下还区分 **personal AT（个人空间）** 与 **workspace AT（组织/团队空间）**，选错 `workspace_id` 会导致签发到个人免费空间而非目标团队空间。

### 8.2 授权分支、可选参数与不可恢复门禁

| 场景 / 参数 | 现象或用途 | 处置建议 |
| :--- | :--- | :--- |
| **`login_hint=<email>`** | 预填登录邮箱 | 跳过手输邮箱页或跳过 `choose-an-account`，减少操作步骤。 |
| **`prompt=login`** | 显式确认登录态 | 文档 2.2 提示：**若命中绑手机门禁，去掉 `prompt=login` 重试**；若想复用已有统一会话，用 `prompt=select_account`（`desktop-auth` 默认行为）。 |
| **`allowed_workspace_id=<ws>`** | 锁定目标工作区授权变体 | 适用于多空间账号定向授权。 |
| **MFA 接口变体** | 首选 `POST /api/accounts/mfa/verify` | 文档 2.1 还记录了两个变体端点：`POST /api/accounts/mfa/challenge/{id}/verify` 与 `POST /api/accounts/mfa/totp/verify`。 |
| **重定向终态 `/email-verification`** | 页面提示会话已结束或需邮箱 OTP | 登录态 Cookie 已过期，或处于无密码 OTP 流程（三轮第 3 条可见需从 `login_methods` 切换 `password`）。 |
| **重定向终态 `/add-phone`** | 命中绑定手机号门禁 | 反复重试无意义，需人工绑定手机或跳过该账号。 |
| **SPA 特殊路由 `/device-limit`、`/step-up/:id`** | 三轮第 10 条路由清单中可见 | 分别对应设备数上限与高风险二次校验（Step-up Verification），均需人工介入。 |
| **`workspace/select` 返回 `409 invalid_state`** | 已登录态直接调接口报错 | 必须先经过前置授权页初始化有效会话状态与 `auth-session-minimized` Cookie。 |
| **PKCE 会话超时与单次消费** | `vm2api` 内存会话 TTL 为 **10 分钟** | 超时需重新生成授权链接；授权码 `code` 仅能使用一次，不可重放；回调校验 `state` 与 `vm_id` 必须完全一致。 |
| **换票出口实时解析** | `vm2api` 不会绑定生成链接时的旧代理快照 | `exchangeCodexAuthCode` 在真正换票时才解析槽位当前绑定的代理出口，避免 10 分钟内代理重分配后走错出口。 |

---

## 9. JWT 结构、身份防串号与工作区状态核查

### 9.1 Token 载荷关键字段（实测 + `openai-jwt.mjs`）

从 `/oauth/token` 拿回 `access_token`、`refresh_token`、`id_token` 后（参考 [openai-jwt.mjs](../src/lib/oauth/openai-jwt.mjs)）：

- **身份读取优先级**：优先解码 `id_token`（含 OIDC profile 与订阅有效期），缺项再由 `access_token` 补齐；**不要轻信外部服务明文回显的 `email` / `account_id`**。
- **`https://api.openai.com/auth` 嵌套声明**：
  - `chatgpt_account_id`：当前授权归属的工作区 ID（作为后续请求的 `chatgpt-account-id` 请求头）；
  - `chatgpt_user_id`（`user-*`）与 `chatgpt_account_user_id`（`user-*__<workspace_id>`）；
  - `chatgpt_plan_type`（如 `self_serve_business_prolite`）；
  - `chatgpt_subscription_active_until`（主要存在于 `id_token`，数字秒/毫秒或 ISO 时间）；
  - `amr`：已完成的认证方式数组（如 `pwd`、`otp`、`mfa`、`urn:openai:amr:otp_totp`）；
  - `chatgpt_data_residency` / `chatgpt_compute_residency`。
- **`https://api.openai.com/profile` 嵌套声明**：`email`、`email_verified`、`name`。
- **顶层标准声明**：`client_id`、`scp`（**必须包含 `offline_access` 才会签发 `refresh_token`**）、`iat`、`nbf`、`exp`、`sub`。

### 9.2 防串号与工作区异常态检查

1. **强一致身份校验（[codex-relogin.mjs](../src/lib/oauth/codex-relogin.mjs)）**：
   - 写入槽位前校验 JWT 解析出的 `email` 是否等于登记邮箱；若槽位已记录 `chatgpt_account_id`，还必须校验新票的 `chatgpt_account_id` 与旧值一致，否则报 `identity_mismatch` 拒绝覆盖，防止多号登录串号。
2. **工作区计费/停用状态留意**：
   - 三轮第 7 条 `/api/auth/session` 返回的 `account` 对象包含 `isDelinquent`（欠费标记）、`gracePeriodId`、`organizationId`；文档 3.4 的 `GET /backend-api/accounts/check/v4-2023-04-27` 返回 `is_deactivated`。
   - 一旦空间出现 `deactivated_workspace`、`workspace_not_found` 或欠费停用，应停止对该空间继续换票或轮转。

---

## 10. 令牌刷新、失效巡检与错误归类口径

### 10.1 刷新轮换竞争保护（避免把活 RT 烧成 `invalid_grant`）

- OpenAI 的 `refresh_token` 在刷新时可能发生轮换（返回新的 `refresh_token`）。如果多个进程或内核并发拿同一个旧 `refresh_token` 去刷，后到的一方会触发 `invalid_grant` 导致整槽掉线。
- `vm2api`（[codex-login-guard.mjs](../src/lib/oauth/codex-login-guard.mjs)）的正确处理顺序：
  1. 探测只走只读接口（模型列表 `GET /backend-api/codex/models` 或用量窗口 `GET /backend-api/wham/usage`），**不发付费推理，且默认探测只用 AT、不乱刷 RT**；
  2. 遇到 `401/403` 时，**先重读磁盘上的凭据文件**（内核可能已经静默完成过一轮轮换），若磁盘上已是新 AT 则用新 AT 再探一次；
  3. 确认失效后才调用一次 `refreshCodexAccessToken`；
  4. 刷新成功后**原子落盘新 `access_token`、轮换后的新 `refresh_token`、新 `id_token` 与 `expires_at`**，并重启该槽 Codex 内核以丢弃内存中旧票。

### 10.2 常见状态码的准确归类（不要混为一谈）

| 状态 / 现象 | 真正含义 | 正确处置 |
| :--- | :--- | :--- |
| **`401`（如 `token_revoked`）** | AT 过期或失效 | 先重读磁盘 → 尝试一次 `refresh_token` 刷新 → 只有刷新被拒（`refresh_rejected`）或缺少 RT 才计入认证失败；默认连续失败 2 次才标 `oauth_invalid_grant` 出池。 |
| **刚刷新出的新 AT 仍报 `401 / 403`** | 归类为 `forbidden`（账号被封、空间停用或地区受限） | **重登无法解决**，切勿触发死循环重登，需人工核查账号或出口地区。 |
| **`403` 返回 HTML 页面** | Cloudflare 拦截或出口 IP 落在封禁地区 | 先查 `GET https://chatgpt.com/cdn-cgi/trace` 看 `loc` / `colo`（规避 `HK/CN/RU/KP/IR/SY/CU` 等封禁区域），**避免把正常活号误判为封号**。 |
| **`409`** | 成员/并发操作瞬时冲突（非权限拒绝） | 线性退避重试（如 5s / 10s / 15s，最多 3 次）。 |
| **`429`** | 接口限流（尤其邀请与高频换票端点） | 指数退避 + 降频，避免连点把出口 IP 打进风控。 |

### 10.3 出口一致性与失败熔断

- **出口一致**：登录、换票、刷新、推理和探测应尽量走同一槽位绑定的代理出口，代理地址统一规范为 `socks5h://`（确保 DNS 在代理侧解析，不泄漏本地 DNS）。`vm2api` 对未绑定代理的槽位默认 **fail closed**（除非显式绑定本地出口 `px-local`）。
- **重登冷却与自动熔断（[codex-relogin.mjs](../src/lib/oauth/codex-relogin.mjs)）**：默认失败冷却 **30 分钟**（`relogin_cooldown_min`），连续失败 **3 次**（`max_relogin_failures`）自动置 `auto_paused: too_many_failures`，防止错误密码或上游异常被误判为撞库攻击。

---

## 11. `vm2api` 外部登录服务协议与安全配置规范

如果你在 `vm2api` 中使用「设置 → GPT 登录」对接自建或可信的外部登录服务（[codex-login-service.mjs](../src/lib/oauth/codex-login-service.mjs)、[docs/OAUTH.md](./OAUTH.md)），需满足以下接口与安全规范：

- **请求协议**：
  ```http
  POST {endpoint}
  Content-Type: application/json
  Accept: application/x-ndjson, application/json
  ```
  ```json
  {
    "action": "start",
    "email": "<email>",
    "auth_mode": "password_2fa",
    "password": "<password>",
    "mfa_secret": "<totp_secret>",
    "proxy": "socks5h://user:pass@host:port"
  }
  ```
  （当槽位为本机出口且未配置部署代理时不传 `proxy` 字段，界面会标注“登录没有走槽位出口”。）
- **响应解析**：支持 NDJSON 事件流或单个 JSON；进度与心跳自动跳过；首个 `{"type":"result","payload":{...}}` 或包含 `credential` / `error` / 终态 `status`（`active`/`ok`/`success`/`succeeded`/`failed`/`error`/`auth_failed`）的对象决定结果。成功时 `credential` **必须同时包含 `access_token`、`refresh_token`、`id_token`**。
- **强制安全约束**：
  1. **公网必须 HTTPS**：仅 `localhost`、单标签内网名（如 Docker 服务名）、RFC1918 / 回环 / 链路本地地址允许明文 `http://`；URL 不允许内嵌账密。
  2. **禁止跟随重定向**：请求固定 `redirect: 'manual'`，防止密码和 2FA 密钥被 302 转发到未知主机。
  3. **静态加密门槛**：保存账号密码/2FA 资料到 SQLite（`settings.codex_login:<vmId>`）前，宿主机必须配置 `VM2API_DB_SECRET`，否则接口直接返回 `409 encryption_required`；更换密钥后旧加密数据不可解，需重新填写。
  4. **防密钥回显与超时**：自定义请求头最多 20 条（值支持 `{{uuid}}` 动态替换），错误只记录短码不透传含密正文；总超时默认 25 分钟（1~60 分钟可配），流空闲超时 60 秒，响应上限 8 MiB；单批导入上限 100 行，并发 1~8（默认 2）。

---

