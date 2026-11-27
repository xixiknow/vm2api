# OpenAI / Codex OAuth 抓包全量请求与参数汇总

> **文档定位**：将三轮手动抓包（`[上1~9]`、`[补1~4]`、`[三1~10]`）中的**全部请求、URL、Query 参数、HTTP 请求头、Cookie 字段、Request Body、Response JSON 结构**按真实执行时序汇总到同一份参考文档中。
>
> **配套流程图与链路分析**：[codex-oauth-flow-analysis.md](./codex-oauth-flow-analysis.md)
>
> **脱敏说明**：为避免凭据泄露，原抓包中的明文密码、真实邮箱/姓名、出口 IP、真实账号/工作区/因子 UUID、一次性 `code`、JWT 签名段、`sessionToken`、Cloudflare/Sentinel 原始串均已替换为带类型语义的占位符（如 `<REDACTED_PASSWORD>`、`<org_workspace_id>`、`ac.1.<auth_code>`）；所有接口路径、参数键名、固定枚举值、HTTP 头名、Cookie 键名与 JSON 结构均按原抓包完整保留。

---

## 目录与请求总索引（按执行时序）

| 序号 | 原抓包编号 | 阶段 | Method & Endpoint | 是否必需（取 Codex 凭据） |
| :--- | :--- | :--- | :--- | :--- |
| **01** | `[三1]` | 第一段：ChatGPT Web | `GET https://chatgpt.com/api/auth/csrf` | 仅 Web 路径需要 |
| **02** | `[补1]` | 第一段：ChatGPT Web | `POST https://chatgpt.com/api/auth/signin/openai` | 仅 Web 路径需要 |
| **03** | `[三2]` | 第一段：ChatGPT Web | `GET https://auth.openai.com/oauth/authorize` | 仅 Web 路径需要 |
| **04** | `[三10]` | 第一段：SPA 静态资源 | `GET https://auth-cdn.oaistatic.com/assets/manifest-54237429.js` | SPA 路由清单参考 |
| **05** | `[补2]` | 第一段：ChatGPT Web | `GET https://auth.openai.com/api/accounts/client_auth_session_dump` (`ws=0`) | 只读状态拉取 |
| **06** | `[三3]` | 第一段：ChatGPT Web | `POST https://auth.openai.com/api/accounts/passwordless/send-otp` | 触发密码选项展示 |
| **07** | `[上1]` | 第一段：ChatGPT Web | `POST https://auth.openai.com/api/accounts/password/verify` | 核心认证（密码） |
| **08** | `[上2]` | 第一段：ChatGPT Web | `POST https://auth.openai.com/api/accounts/mfa/verify` | 核心认证（TOTP） |
| **09** | `[补3]` | 第一段：ChatGPT Web | `GET https://auth.openai.com/api/accounts/client_auth_session_dump` (`ws=4`) | 只读状态拉取 |
| **10** | `[补4]` | 第一段：ChatGPT Web | `POST https://auth.openai.com/api/accounts/workspace/select` | Web 空间选择 |
| **11** | `[三6]` | 第一段：ChatGPT Web | `GET https://chatgpt.com/api/auth/callback/openai` | Web 回调建会话 |
| **12** | `[三7]` | 第一段：ChatGPT Web | `GET https://chatgpt.com/api/auth/session` | 取 Web Session |
| **13** | `[上3~5]` | 第一段：Web 业务冗余 | `GET/PATCH https://chatgpt.com/backend-api/accounts/<ws>/users/<uid>/onboarding_answers` | 冗余（非 OAuth） |
| **14** | `[上6 / 三8]` | 第二段：Codex OAuth | `GET https://chatgpt.com/codex/desktop-auth` | **核心入口** |
| **15** | `[三9]` | 第二段：Codex OAuth | `GET https://auth.openai.com/oauth/authorize` | **核心授权** |
| **16** | `[上7]` | 第二段：Codex OAuth | `POST https://auth.openai.com/api/accounts/session/select` | 复用统一会话 `us_*` |
| **17** | `[上8]` | 第二段：Codex OAuth | `POST https://auth.openai.com/api/accounts/workspace/select` | **Codex 空间选择** |
| **18** | `[上9]` | 第二段：Codex OAuth | `GET http://localhost:1455/auth/callback` | **核心回调拿 `code`** |
| **19** | *(后端终点)* | 第二段：Codex OAuth | `POST https://auth.openai.com/oauth/token` | **本地/后端换票** |

> **抓包中确认未发生的请求（`[三4]`、`[三5]`）**：`GET https://auth.openai.com/mfa-challenge/<factor_id>?auth_page=...`、`GET https://auth.openai.com/workspace?auth_page=...`、`GET https://auth.openai.com/sign-in-with-chatgpt/codex/consent` 均由 `auth.openai.com` 的 React Router SPA 在前端直接切换，不产生新的服务端整页 `GET`。

---

## 第一段：ChatGPT Web 登录（`client_id = app_X8zY6vW2pQ9tR3dE7nK1jL5gH`）

### 01. `[三1]` 获取 NextAuth CSRF Token

- **Method & URL**: `GET https://chatgpt.com/api/auth/csrf`
- **Query 参数**: 无
- **Request Headers**:
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `accept` | `*/*` |
  | `accept-language` | `en-US,en;q=0.9` |
  | `cache-control` | `no-cache` |
  | `pragma` | `no-cache` |
  | `priority` | `u=1, i` |
  | `referer` | `https://chatgpt.com/auth/login_with?callback_path=%2F&screen_hint=login_or_signup&login_hint=<email_encoded>&auth_session_logging_id=<uuid>&ext-oai-did=<oai_did>` |
  | `sec-ch-ua` | `"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"` |
  | `sec-ch-ua-mobile` | `?0` |
  | `sec-ch-ua-platform` | `"Windows"` |
  | `sec-fetch-dest` | `empty` |
  | `sec-fetch-mode` | `cors` |
  | `sec-fetch-site` | `same-origin` |
  | `user-agent` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36` |
- **携带 Cookie 列表（`chatgpt.com` 域，共 24 项）**:
  `oai-did`, `oai-did-first-seen`, `oai-mweb-route`, `oai-mweb-origin`, `_cfuvid`, `__cflb`, `__Host-next-auth.csrf-token`, `__Secure-next-auth.callback-url`, `_account`, `oai-hlib`, `oai-tpp-onboarding-completed-at`, `codex_sidebar_width`, `_puid`, `__oailb`, `oai_pl_permission_state`, `_dd_s_v2`, `cf_clearance`, `__cf_bm`, `oai-client-session-epoch`, `__Secure-next-auth.state`, `__Secure-next-auth.pkce.code_verifier`, `oai-sc`, `oai-asli`, `oai-mweb-auth-pending`
- **Response JSON**:
  ```json
  {
    "csrfToken": "<csrf_token_hex64>"
  }
  ```

---

### 02. `[补1]` NextAuth 发起 OpenAI 登录

- **Method & URL**: `POST https://chatgpt.com/api/auth/signin/openai`
- **Query 参数**:
  | 参数名 | 值 / 格式 |
  | :--- | :--- |
  | `prompt` | `login` |
  | `screen_hint` | `login_or_signup` |
  | `auth_session_logging_id` | `<uuid>` |
  | `login_hint` | `<email>` |
- **Request Headers**: 同 **01**，额外增加：
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `content-type` | `application/x-www-form-urlencoded` |
  | `origin` | `https://chatgpt.com` |
- **携带 Cookie**: 同 **01**（24 项）
- **Request Body (`application/x-www-form-urlencoded`)**:
  | 字段名 | 值 / 格式 |
  | :--- | :--- |
  | `callbackUrl` | `https://chatgpt.com/` |
  | `csrfToken` | `<csrf_token_hex64>`（来自 **01**） |
  | `json` | `true` |
- **Response JSON**:
  ```json
  {
    "url": "https://auth.openai.com/oauth/authorize?client_id=app_X8zY6vW2pQ9tR3dE7nK1jL5gH&scope=openid%20email%20profile%20offline_access%20model.request%20model.read%20organization.read%20organization.write&response_type=code&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Fopenai&audience=https%3A%2F%2Fapi.openai.com%2Fv1&device_id=<oai_did>&prompt=login&screen_hint=login_or_signup&auth_session_logging_id=<uuid>&login_hint=<email_encoded>&ccaps=login_methods%20chatgpt_login_finalizer_v1&state=<state>&code_challenge=<s256_challenge>&code_challenge_method=S256"
  }
  ```

---

### 03. `[三2]` 进入 `auth.openai.com` 授权页（ChatGPT Web）

- **Method & URL**: `GET https://auth.openai.com/oauth/authorize`
- **Query 参数（14 项，即 **02** 响应返回的 `url`）**:
  | 参数名 | 值 / 格式 |
  | :--- | :--- |
  | `client_id` | `app_X8zY6vW2pQ9tR3dE7nK1jL5gH` |
  | `scope` | `openid email profile offline_access model.request model.read organization.read organization.write` |
  | `response_type` | `code` |
  | `redirect_uri` | `https://chatgpt.com/api/auth/callback/openai` |
  | `audience` | `https://api.openai.com/v1` |
  | `device_id` | `<oai_did>` |
  | `prompt` | `login` |
  | `screen_hint` | `login_or_signup` |
  | `auth_session_logging_id` | `<uuid>` |
  | `login_hint` | `<email>` |
  | `ccaps` | `login_methods chatgpt_login_finalizer_v1` |
  | `state` | `<state_b64url>` |
  | `code_challenge` | `<s256_challenge_b64url>` |
  | `code_challenge_method` | `S256` |
- **Request Headers**:
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `accept` | `text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7` |
  | `accept-language` | `en-US,en;q=0.9` |
  | `priority` | `u=0, i` |
  | `referer` | `https://chatgpt.com/` |
  | `sec-ch-ua` / `mobile` / `platform` | 同 Chrome 156 Windows |
  | `sec-fetch-dest` | `document` |
  | `sec-fetch-mode` | `navigate` |
  | `sec-fetch-site` | `cross-site` |
  | `upgrade-insecure-requests` | `1` |
  | `user-agent` | Chrome 156 Windows UA |
- **携带 Cookie 列表（`auth.openai.com` 域）**:
  `oai-did`, `rg_context`, `iss_context`, `oaicom-stable-id`, `__oailb`, `__cflb`, `_cfuvid`（多条域/路径变体）, `cf_clearance`, `__cf_bm`, `auth-session-minimized-client-checksum`, `oai-client-auth-info`, `error_page_verifier`, `__Host-unified_session_manifest`, `auth-session-minimized`, `oai-sc`
- **作用**: 初始化新会话 `authsess_bh_*`（`ws=0`），通过 `Set-Cookie` 写入 `__Host-oai-initial-email-page` 与新版 `auth-session-minimized`，返回 React Router SPA 壳页面。

---

### 04. `[三10]` 加载认证 SPA 路由清单

- **Method & URL**: `GET https://auth-cdn.oaistatic.com/assets/manifest-54237429.js`
- **Request Headers**: `Origin: https://auth.openai.com`, `Referer: https://auth.openai.com/`, `User-Agent`, `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`
- **Response 内容要点**: 注册 `window.__reactRouterManifest`，包含全站前端路由定义（解释为何同域 `continue_url` 不产生整页 `GET`）。抓包片段可见的核心路由：
  | Route ID | 前端路径 (`path`) | 说明 |
  | :--- | :--- | :--- |
  | `LOG_IN` | `log-in` | 账号输入页 |
  | `LOG_IN_PASSWORD` | `log-in/password` | 密码登录页 |
  | `LOG_IN_PASSKEY` | `log-in/passkey` | Passkey 登录页 |
  | `UNIFIED_LOG_IN_OR_SIGN_UP_INPUT` | `log-in-or-create-account` | 统一登录/注册入口 |
  | `EMAIL_VERIFICATION` | `email-verification` | 邮箱验证码 / 切密码页 |
  | `CHOOSE_AN_ACCOUNT` | `choose-an-account` | 多账号/统一会话选择页 |
  | `IDENTITY_CONFIRMATION` | `identity-confirmation` | 身份确认页 |
  | `ADD_PHONE` / `PHONE_VERIFICATION` | `add-phone` / `phone-verification` | 绑手机门禁 / 手机验证 |
  | `DEVICE_LIMIT` | `device-limit` | 设备数量限制页 |
  | `STEP_UP_VERIFICATION` | `step-up/:challenge_id` | 增强二次验证页 |
  | `PASSKEY_ENROLL` / `MAGIC_LINK` | `passkey-enroll` / `magic-link` | Passkey 绑定 / 魔法链接 |
  | `DEVICE_AUTH_CALLBACK` | `deviceauth/callback` | 设备码授权回调页 |

---

### 05. `[补2]` 读取初始认证会话快照（`ws=0`）

- **Method & URL**: `GET https://auth.openai.com/api/accounts/client_auth_session_dump`
- **Request Headers**:
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `accept` | `*/*` |
  | `accept-language` | `en-US,en;q=0.9` |
  | `openai-auth-page` | `<initial_auth_page>`（与 Cookie `__Host-oai-initial-email-page` 一致） |
  | `priority` | `u=1, i` |
  | `referer` | `https://auth.openai.com/` |
  | `sec-ch-ua*` / `sec-fetch-*` / `user-agent` | 同源 CORS Fetch 头 |
- **关键 Cookie 状态**:
  - `__Host-oai-initial-email-page`: `<initial_auth_page>`
  - `auth-session-minimized-client-checksum`: `{"affinity":"base64({rc:32, cs:<hex>, ws:0, wt:<epoch>})"}`
  - `__Host-unified_session_manifest`: `sessions: []`
- **Response JSON**:
  ```json
  {
    "client_auth_session": {
      "app_name_enum": "chat",
      "auth_session_logging_id": "<uuid>",
      "country_code_hint": "US",
      "destination_app_name": "ChatGPT Web",
      "email": "<email>",
      "email_verification_mode": "passwordless_login",
      "openai_client_id": "app_X8zY6vW2pQ9tR3dE7nK1jL5gH",
      "original_screen_hint": "login_or_signup",
      "passwordless_disabled": false,
      "passwordless_email_otp_send_pending": true,
      "passwordless_otp_from_password_redirect": false,
      "promo": "",
      "requested_oauth_scopes": [
        "email",
        "model.read",
        "model.request",
        "offline_access",
        "openid",
        "organization.read",
        "organization.write",
        "profile"
      ],
      "session_id": "authsess_bh_<id>",
      "signup_source": "",
      "username": {
        "kind": "email",
        "value": "<email>"
      }
    },
    "session_id": "authsess_bh_<id>"
  }
  ```

---

### 06. `[三3]` 触发无密码 OTP 并获取可用登录方式列表

- **Method & URL**: `POST https://auth.openai.com/api/accounts/passwordless/send-otp`
- **Request Headers**:
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `accept` | `*/*` |
  | `accept-language` | `en-US,en;q=0.9` |
  | `content-length` | `0` |
  | `openai-auth-page` | `<initial_auth_page>` |
  | `openai-sentinel-token` | `{"e":"<sentinel_code>"}`（反机器人门禁头） |
  | `origin` | `https://auth.openai.com` |
  | `priority` | `u=1, i` |
  | `referer` | `https://auth.openai.com/` |
  | `sec-ch-ua*` / `sec-fetch-*` / `user-agent` | 同源 CORS Fetch 头 |
  | `x-access-flow-invocation-id` | `<uuid>` |
  | `x-openai-document-navigation-id` | `<uuid>` |
- **关键 Cookie 状态**: `auth-session-minimized` (`ws=0`), `auth-session-minimized-client-checksum` (`ws=0`), `oai-sc`, `cf_clearance`, `__cf_bm`, `_dd_s`, `oai-client-auth-info`, `error_page_verifier`, `__Host-unified_session_manifest`
- **Request Body**: 空（`content-length: 0`）
- **Response JSON**:
  ```json
  {
    "continue_url": "https://auth.openai.com/email-verification?auth_page=<next_auth_page>",
    "method": "GET",
    "page": {
      "type": "email_otp_verification",
      "backstack_behavior": "default",
      "payload": {
        "email_verification_mode": "passwordless_login",
        "login_methods": [
          { "type": "passwordless_otp" },
          { "type": "password" }
        ]
      }
    },
    "oai-client-auth-session": {
      "app_name_enum": "chat",
      "auth_session_logging_id": "<uuid>",
      "country_code_hint": "US",
      "destination_app_name": "ChatGPT Web",
      "email": "<email>",
      "email_verification_mode": "passwordless_login",
      "openai_client_id": "app_X8zY6vW2pQ9tR3dE7nK1jL5gH",
      "original_screen_hint": "login_or_signup",
      "passwordless_disabled": false,
      "passwordless_email_otp_send_pending": false,
      "passwordless_otp_from_password_redirect": false,
      "passwordless_login_magic_link_sent": false,
      "promo": "",
      "requested_oauth_scopes": ["email", "model.read", "model.request", "offline_access", "openid", "organization.read", "organization.write", "profile"],
      "session_id": "authsess_bh_<id>",
      "signup_source": "",
      "username": { "kind": "email", "value": "<email>" }
    }
  }
  ```

---

### 07. `[上1]` 校验账号密码

- **Method & URL**: `POST https://auth.openai.com/api/accounts/password/verify`
- **Request Headers**:
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `accept` | `application/json` |
  | `accept-language` | `en-US,en;q=0.9` |
  | `content-type` | `application/json` |
  | `openai-auth-page` | `<password_page_token>` |
  | `openai-sentinel-token` | `{"p":"<pow_attestation>","t":"<telemetry>","c":"<challenge>","id":"<oai_did>","flow":"password_verify"}` |
  | `origin` | `https://auth.openai.com` |
  | `priority` | `u=1, i` |
  | `referer` | `https://auth.openai.com/` |
  | `sec-ch-ua*` / `sec-fetch-*` / `user-agent` | 同源 CORS Fetch 头 |
  | `traceparent` | `00-0000000000000000<trace_hex16>-<span_hex16>-01` |
  | `tracestate` | `dd=s:1;o:rum` |
  | `x-access-flow-invocation-id` | `<uuid>` |
  | `x-datadog-origin` | `rum` |
  | `x-datadog-parent-id` | `<uint64>` |
  | `x-datadog-sampling-priority` | `1` |
  | `x-datadog-trace-id` | `<uint64>` |
  | `x-openai-document-navigation-id` | `<uuid>` |
- **关键 Cookie 状态**: `auth-session-minimized` (`ws=1`), `auth-session-minimized-client-checksum` (`ws=1`), `oai-sc`, `cf_clearance`, `__cf_bm`, `_cfuvid`, `__cflb`, `__oailb`, `oai-did`, `rg_context`, `iss_context`, `oaicom-stable-id`, `_dd_s`
- **Request Body (`application/json`)**:
  ```json
  {
    "password": "<REDACTED_PASSWORD>"
  }
  ```
- **Response JSON**:
  ```json
  {
    "continue_url": "https://auth.openai.com/mfa-challenge/<factor_id>?auth_page=<mfa_auth_page>",
    "method": "GET",
    "page": {
      "type": "mfa_challenge",
      "backstack_behavior": "default",
      "payload": {
        "factor_id": "<factor_id>",
        "factors": [
          {
            "id": "<factor_id>",
            "factor_type": "totp",
            "is_recovery": false,
            "metadata": null
          }
        ]
      }
    },
    "oai-client-auth-session": {
      "app_name_enum": "chat",
      "auth_session_logging_id": "<uuid>",
      "country_code_hint": "US",
      "destination_app_name": "ChatGPT Web",
      "email": "<email>",
      "email_verification_mode": "passwordless_login",
      "openai_client_id": "app_X8zY6vW2pQ9tR3dE7nK1jL5gH",
      "original_screen_hint": "login_or_signup",
      "passwordless_disabled": false,
      "passwordless_email_otp_send_pending": false,
      "passwordless_login_magic_link_sent": false,
      "passwordless_otp_from_password_redirect": false,
      "promo": "",
      "requested_oauth_scopes": ["email", "model.read", "model.request", "offline_access", "openid", "organization.read", "organization.write", "profile"],
      "session_id": "authsess_bh_<id>",
      "signup_source": "",
      "username": { "kind": "email", "value": "<email>" },
      "mfa_factors": [
        { "id": "<factor_id>", "factor_type": "totp", "is_recovery": false, "metadata": null }
      ],
      "mfa_challenge_factors": [
        { "id": "<factor_id>", "factor_type": "totp", "is_recovery": false, "metadata": null }
      ],
      "totp_ux_enabled": false
    }
  }
  ```

---

### 08. `[上2]` 校验 2FA（TOTP 动态码）

- **Method & URL**: `POST https://auth.openai.com/api/accounts/mfa/verify`
- **Request Headers**: 同 **07**，以下字段更新：
  | Header | 更新值 |
  | :--- | :--- |
  | `openai-auth-page` | `<mfa_auth_page>`（取自 **07** 响应的 `continue_url` 查询参数 `auth_page`） |
  | `openai-sentinel-token` | `{"p":"<...>","t":"<...>","c":"<...>","id":"<oai_did>","flow":"verify_mfa"}` |
  | `x-access-flow-invocation-id` / `traceparent` / `x-datadog-*` | 每次请求重新生成 |
- **关键 Cookie 状态**: `auth-session-minimized` (`ws=3`), `auth-session-minimized-client-checksum` (`ws=3`), 轮换后的 `oai-sc`
- **Request Body (`application/json`)**:
  ```json
  {
    "id": "<factor_id>",
    "type": "totp",
    "code": "<6位TOTP码>"
  }
  ```
- **Response JSON**:
  ```json
  {
    "continue_url": "https://auth.openai.com/workspace?auth_page=<workspace_auth_page>",
    "method": "GET",
    "page": {
      "type": "workspace",
      "backstack_behavior": "default",
      "payload": {
        "workspaces": [
          {
            "id": "<org_workspace_id>",
            "name": "<workspace_display_name>",
            "kind": "organization"
          },
          {
            "id": "<personal_workspace_id>",
            "name": null,
            "kind": "personal",
            "profile_picture_alt_text": "<display_name>"
          }
        ]
      }
    },
    "oai-client-auth-session": {
      "app_name_enum": "chat",
      "auth_session_logging_id": "<uuid>",
      "country_code_hint": "US",
      "destination_app_name": "ChatGPT Web",
      "email": "<email>",
      "name": "<display_name>",
      "mfa_factors": [
        { "factor_type": "totp", "id": "<factor_id>", "is_recovery": false, "metadata": { "challenge_issue_count": 1 } }
      ],
      "mfa_challenge_factors": [
        { "factor_type": "totp", "id": "<factor_id>", "is_recovery": false, "metadata": null }
      ],
      "workspaces": [
        { "id": "<org_workspace_id>", "name": "<workspace_display_name>", "kind": "organization" },
        { "id": "<personal_workspace_id>", "name": null, "kind": "personal", "profile_picture_alt_text": "<display_name>" }
      ],
      "session_id": "authsess_bh_<id>",
      "totp_ux_enabled": false
    }
  }
  ```

---

### 09. `[补3]` 读取已认证会话快照（`ws=4`，选工作区前）

- **Method & URL**: `GET https://auth.openai.com/api/accounts/client_auth_session_dump`
- **Request Headers**: 同 **05**，但 `openai-auth-page` 已轮换为 `<workspace_auth_page>`，并额外带有 `traceparent`、`tracestate`、`x-datadog-*` 链路头。
- **关键 Cookie 状态**: `auth-session-minimized` (`ws=4`), `auth-session-minimized-client-checksum` (`ws=4`), 轮换后的 `oai-sc`, `oai-client-auth-info`, `error_page_verifier`, `__Host-unified_session_manifest` (`sessions: []`)
- **Response JSON**: 与 **08** 中的 `oai-client-auth-session` 字段完全一致，包裹在 `{"client_auth_session": {...}, "session_id": "authsess_bh_<id>"}` 中。

---

### 10. `[补4]` 选择工作区（ChatGPT Web）

- **Method & URL**: `POST https://auth.openai.com/api/accounts/workspace/select`
- **Request Headers**: 同 **07**，其中：
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `openai-auth-page` | `<workspace_auth_page>` |
  | `openai-sentinel-token` | `{"p":"<...>","t":"<...>","c":"<...>","id":"<oai_did>","flow":"authorize_continue"}` |
- **关键 Cookie 状态**: `auth-session-minimized` (`ws=4`), `auth-session-minimized-client-checksum` (`ws=4`), 轮换后的 `oai-sc`
- **Request Body (`application/json`)**:
  ```json
  {
    "workspace_id": "<org_workspace_id>"
  }
  ```
- **Response JSON**:
  ```json
  {
    "continue_url": "https://chatgpt.com/api/auth/callback/openai?code=ac.1.<web_auth_code>&scope=openid+email+profile+offline_access+model.request+model.read+organization.read+organization.write&state=<state>&iss=https%3A%2F%2Fauth.openai.com",
    "method": "GET",
    "page": {
      "type": "external_url",
      "backstack_behavior": "default",
      "payload": {
        "url": "https://chatgpt.com/api/auth/callback/openai?code=ac.1.<web_auth_code>&scope=openid+email+profile+offline_access+model.request+model.read+organization.read+organization.write&state=<state>&iss=https%3A%2F%2Fauth.openai.com"
      }
    },
    "oai-client-auth-session": { "...": "同 09" }
  }
  ```

---

### 11. `[三6]` ChatGPT Web NextAuth 回调

- **Method & URL**: `GET https://chatgpt.com/api/auth/callback/openai`
- **Query 参数**:
  | 参数名 | 值 / 格式 |
  | :--- | :--- |
  | `code` | `ac.1.<web_auth_code>`（来自 **10**） |
  | `scope` | `openid email profile offline_access model.request model.read organization.read organization.write` |
  | `state` | `<state>`（与 **02** 一致） |
  | `iss` | `https://auth.openai.com` |
- **Request Headers**: 同 **03**（整页文档导航），额外 `referer: https://auth.openai.com/`、`sec-fetch-user: ?1`
- **关键 Cookie**: `chatgpt.com` 域的 `__Secure-next-auth.state`、`__Secure-next-auth.pkce.code_verifier`、`__Host-next-auth.csrf-token`、`oai-asli`、`oai-mweb-auth-pending`、`cf_clearance`、`__cf_bm`、`oai-sc` 等。
- **作用**: `chatgpt.com` 服务端完成换票并写入 `__Secure-next-auth.session-token.0` 与 `.1`；同时 `auth.openai.com` 在完成授权时已写入 `__Host-usc_<cookie_id>` 和 `__Host-unified_session_manifest`（内含 `us_<unified_session_id>`）。

---

### 12. `[三7]` 获取 ChatGPT Web 当前会话

- **Method & URL**: `GET https://chatgpt.com/api/auth/session`
- **Response JSON 结构**:
  ```json
  {
    "WARNING_BANNER": "DO NOT SHARE ANY PART OF THE INFORMATION YOU SEE HERE...",
    "accessToken": "<RS256_JWT>",
    "account": {
      "id": "<org_workspace_id>",
      "planType": "self_serve_business_prolite",
      "isDelinquent": true,
      "gracePeriodId": "default",
      "structure": "workspace",
      "organizationId": "org-<id>",
      "residencyRegion": "no_constraint",
      "computeResidency": "no_constraint",
      "isFedrampCompliantWorkspace": false,
      "createdTime": 1792843231.808,
      "isUsageBasedSeatEnabled": false,
      "isConversationClassifierEnabledForWorkspace": false,
      "hasFloraFeature": true,
      "isHipaaCompliantWorkspace": false
    },
    "user": {
      "id": "user-<id>",
      "email": "<email>",
      "name": "<display_name>",
      "idp": "auth0",
      "iat": 1795533190,
      "amr": ["pwd", "urn:openai:amr:password", "otp", "mfa", "urn:openai:amr:otp_totp"],
      "acr": "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
      "mfa": true,
      "created": 1795373333
    },
    "authProvider": "openai",
    "expires": "2027-02-22T15:41:48.283Z",
    "sessionToken": "<JWE_A256GCM_ENCRYPTED>",
    "statsigContext": {
      "locale": "en-US",
      "userAgent": "Mozilla/5.0 ...",
      "ip": "<egress_ip>",
      "country": "US",
      "region": "<region>",
      "regionCode": "<region_code>",
      "deviceId": "<oai_did>",
      "adsSegmentId": 7059
    },
    "marketingEligibility": {
      "bazaar": {}, "pioneer": {}, "maverick": {}, "trailblazer": {},
      "seeker": {}, "stratos": {}, "wayfinder": {}, "impact": {}, "snapchat": {}
    }
  }
  ```
- **其中 `accessToken` JWT 解码结构（RS256）**:
  ```json
  {
    "https://api.openai.com/auth": {
      "user_id": "user-<id>",
      "amr": ["pwd", "urn:openai:amr:password", "otp", "mfa", "urn:openai:amr:otp_totp"],
      "chatgpt_login_finalizer_invite_intent_bound": true,
      "chatgpt_login_finalizer_auth_session_id": "authsess_bh_<id>",
      "chatgpt_account_user_id": "user-<id>__<org_workspace_id>",
      "chatgpt_account_id": "<org_workspace_id>",
      "chatgpt_user_id": "user-<id>",
      "chatgpt_plan_type": "self_serve_business_prolite",
      "chatgpt_data_residency": "no_constraint",
      "chatgpt_compute_residency": "no_constraint"
    },
    "https://api.openai.com/profile": {
      "email": "<email>",
      "email_verified": true,
      "name": "<display_name>"
    },
    "https://api.openai.com/mfa": { "required": "yes" },
    "pwd_auth_time": 1795533188981,
    "session_id": "authsess_bh_<id>",
    "iss": "https://auth.openai.com",
    "sub": "auth0|<sub_id>",
    "aud": ["https://api.openai.com/v1"],
    "client_id": "app_X8zY6vW2pQ9tR3dE7nK1jL5gH",
    "scp": ["openid", "email", "profile", "offline_access", "model.request", "model.read", "organization.read", "organization.write"],
    "iat": 1795533190,
    "exp": 1796397189,
    "jti": "<uuid>",
    "nbf": 1795533190
  }
  ```

---

### 13. `[上3~5]` ChatGPT Web 业务接口（冗余，与 Codex OAuth 无关）

- **URL**: `https://chatgpt.com/backend-api/accounts/<org_workspace_id>/users/user-<id>/onboarding_answers`
- **共同 Request Headers**:
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `accept` | `*/*` |
  | `accept-language` | `en-US,en;q=0.9` |
  | `authorization` | `Bearer <web_access_token_jwt>` |
  | `chatgpt-account-id` | `<org_workspace_id>` |
  | `content-type` | `application/json`（仅 `PATCH` `[上5]`） |
  | `oai-device-id` / `oai-did` | `<oai_did>` |
  | `oai-language` | `en-US` |
  | `origin` | `https://chatgpt.com`（仅 `PATCH` `[上5]`） |
  | `originator` | `Codex Browser` |
  | `priority` | `u=1, i` |
  | `referer` | `https://chatgpt.com/` |
  | `sec-ch-ua*` / `sec-fetch-*` / `user-agent` | 同源 CORS Fetch 头 |
  | `x-openai-codex-window-type` | `browser` |
  | `x-openai-rate-limit-join-workspace` | `1` |
  | `x-openai-rejoin-pro-cta` | `1` |
  | `x-openai-web-frontend` | `codex_webview` |
- **3 条请求明细**:
  - **`[上3]`（GET，贴出的响应实为 profile 接口）**:
    ```json
    {
      "profile_details": {
        "username": "<username>",
        "display_name": "<display_name>",
        "profile_picture_url": "https://cdn.auth0.com/avatars/ow.png",
        "profile_url": "/u/<username>"
      },
      "viewer_access": {
        "is_self": true,
        "can_edit": true,
        "can_edit_username": true
      }
    }
    ```
  - **`[上4]`（GET `onboarding_answers`）**:
    ```json
    {"role": null, "custom_role": "", "use_cases": [], "custom_use_case": ""}
    ```
  - **`[上5]`（PATCH `onboarding_answers`）**:
    - Body: `{"kind": "role", "role": "engineering", "custom_role": ""}`
    - Response: `{"role": "engineering", "custom_role": "", "use_cases": [], "custom_use_case": ""}`

---

## 第二段：Codex Desktop OAuth（`client_id = app_EMoamEEZ73f0CkXaXp7hrann`）

### 14. `[上6 / 三8]` Codex Desktop 授权入口页

- **Method & URL**: `GET https://chatgpt.com/codex/desktop-auth`
- **外层 Query 参数（3 项）**:
  | 参数名 | 值 / 格式 |
  | :--- | :--- |
  | `authorize_url` | URL 编码的内层 `https://auth.openai.com/oauth/authorize?...` |
  | `codex_streamlined_login` | `true` |
  | `no_universal_links` | `1` |
- **内层 `authorize_url` Query 参数（14 项）**:
  | 参数名 | 值 / 格式 |
  | :--- | :--- |
  | `response_type` | `code` |
  | `client_id` | `app_EMoamEEZ73f0CkXaXp7hrann` |
  | `redirect_uri` | `http://localhost:1455/auth/callback` |
  | `scope` | `openid profile email offline_access api.connectors.read api.connectors.invoke` |
  | `code_challenge` | `<s256_challenge_b64url>` |
  | `code_challenge_method` | `S256` |
  | `id_token_add_organizations` | `true` |
  | `codex_cli_simplified_flow` | `true` |
  | `state` | `<state_b64url>` |
  | `originator` | `Codex Desktop` |
  | `codex_app_version` | `0.170.0` |
  | `source_surface_stable_id` | `<uuid_v4>` |
  | `codex_origin_stable_id` | `<uuid_v4>` |
  | `codex_streamlined_login` | `true` |
- **Request Headers**: 整页文档导航头（`sec-fetch-dest: document`、`sec-fetch-mode: navigate`、`sec-fetch-site: none`、`sec-fetch-user: ?1`、`upgrade-insecure-requests: 1`、`priority: u=0, i`）
- **携带 Cookie**: 已登录态的 `chatgpt.com` Cookie（含 `__Secure-next-auth.session-token.0/.1`、`oai-gn`、`_account`、`_account_residency_region`、`_account_is_fedramp`、`cf_clearance`、`__cf_bm`、`oai-sc` 等）。

---

### 15. `[三9]` 进入 `auth.openai.com` Codex 授权页

- **Method & URL**: `GET https://auth.openai.com/oauth/authorize`
- **Query 参数（16 项）**: 包含 **14** 的全部 14 个内层参数，并由 `desktop-auth` 自动追加以下 2 项：
  | 新增参数名 | 值 |
  | :--- | :--- |
  | `prompt` | `select_account` |
  | `screen_hint` | `login_or_signup` |
- **Request Headers**: 整页文档导航头（同 **14**）
- **关键 Cookie（`auth.openai.com` 域）**:
  - **`__Host-usc_<cookie_id>`**（ES256 JWT，解码结构）：
    ```json
    {
      "type": "us",
      "protocol_version": "3",
      "cookie_id": "<cookie_id>",
      "encrypted_authenticated_data": "us_<unified_session_id>",
      "client_secret": "<REDACTED_CLIENT_SECRET>"
    }
    ```
  - **`__Host-unified_session_manifest`**（ES256 JWT，解码结构）：
    ```json
    {
      "version": 3,
      "iat": 1795533189,
      "sessions": [
        {
          "cookie_id": "<cookie_id>",
          "unified_session_id": "us_<unified_session_id>"
        }
      ]
    }
    ```
  - 其余：`oai-did`, `rg_context`, `iss_context`, `oaicom-stable-id`, `__oailb`, `_cfuvid`, `cf_clearance`, `oai-client-auth-info`, `error_page_verifier`, `oai-sc`

---

### 16. `[上7]` 选择已有统一会话（免重输密码与 2FA）

- **Method & URL**: `POST https://auth.openai.com/api/accounts/session/select`
- **Request Headers**:
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `accept` | `application/json` |
  | `accept-language` | `en-US,en;q=0.9` |
  | `content-type` | `application/json` |
  | `openai-sentinel-token` | `{"p":"<...>","t":"<...>","c":"<...>","id":"<oai_did>","flow":"authorize_continue"}` |
  | `origin` | `https://auth.openai.com` |
  | `priority` | `u=1, i` |
  | `referer` | `https://auth.openai.com/` |
  | `sec-ch-ua*` / `sec-fetch-*` / `user-agent` | 同源 CORS Fetch 头 |
  | `traceparent` / `tracestate` / `x-datadog-*` | 链路追踪头 |
  | `x-access-flow-invocation-id` | `<uuid>` |
  | `x-openai-document-navigation-id` | `<uuid>` |
  > 注意：该请求抓包中**没有** `openai-auth-page` 请求头。
- **关键 Cookie 状态**: `__Host-usc_<cookie_id>`, `__Host-unified_session_manifest`, 新建的 `auth-session-minimized`（`app_name_enum: "oaicli"`, `openai_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"`, `originator: "Codex Desktop"`, `ws=0`）, `auth-session-minimized-client-checksum` (`ws=0`), `oai-sc`, Cloudflare Cookie, `_dd_s`
- **Request Body (`application/json`)**:
  ```json
  {
    "session_id": "us_<unified_session_id>"
  }
  ```
- **Response JSON**:
  ```json
  {
    "continue_url": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
    "method": "GET",
    "page": {
      "type": "sign_in_with_chatgpt_codex_consent",
      "backstack_behavior": "default"
    },
    "oai-client-auth-session": {
      "app_name_enum": "oaicli",
      "auth_session_logging_id": "server_<uuid>",
      "country_code_hint": "US",
      "destination_app_name": "Codex",
      "openai_client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
      "originator": "Codex Desktop",
      "originator_display_name": "Codex",
      "promo": "",
      "requested_oauth_scopes": [
        "api.connectors.invoke",
        "api.connectors.read",
        "email",
        "offline_access",
        "openid",
        "profile"
      ],
      "session_id": "authsess_<id>",
      "signup_source": "",
      "unified_sessions": [],
      "email": "<email>",
      "name": "<display_name>",
      "email_verified": true,
      "workspaces": [
        { "id": "<org_workspace_id>", "name": "<workspace_display_name>", "kind": "organization" },
        { "id": "<personal_workspace_id>", "name": null, "kind": "personal", "profile_picture_alt_text": "<display_name>" }
      ]
    }
  }
  ```

---

### 17. `[上8]` Codex 授权选择工作区

- **Method & URL**: `POST https://auth.openai.com/api/accounts/workspace/select`
- **Request Headers**: 同 **16**，但该抓包中**既无 `openai-auth-page` 也无 `openai-sentinel-token`**。
- **关键 Cookie 状态**: `__Host-usc_<cookie_id>`, `__Host-unified_session_manifest`, `auth-session-minimized` (`ws=1`), `auth-session-minimized-client-checksum` (`ws=1`), 轮换后的 `oai-sc`, Cloudflare Cookie, `_dd_s`
- **Request Body (`application/json`)**:
  ```json
  {
    "workspace_id": "<org_workspace_id>"
  }
  ```
- **Response JSON**: *(原抓包未贴出，正常返回含 `continue_url` 的 JSON，指向回调重定向链)*

---

### 18. `[上9]` 最终本地回调（截获授权码 `code`）

- **Method & URL**: `GET http://localhost:1455/auth/callback`
- **Query 参数（4 项）**:
  | 参数名 | 值 / 格式 |
  | :--- | :--- |
  | `code` | `ac.1.<codex_auth_code>`（一次性短时授权码） |
  | `scope` | `openid profile email offline_access api.connectors.read api.connectors.invoke` |
  | `state` | `<state_b64url>`（必须与 **14** 生成时一致） |
  | `iss` | `https://auth.openai.com` |

---

### 19. *(本地/后端终点，浏览器 Network 中不可见)* 用 `code` 换取正式 Token

> 依据文档第 2.2 ③ 与 [src/lib/protocol/codex-models.mjs](../src/lib/protocol/codex-models.mjs) 补充记录，补全端到端参数闭环。

- **Method & URL**: `POST https://auth.openai.com/oauth/token`
- **Request Headers**:
  | Header | 值 / 格式 |
  | :--- | :--- |
  | `accept` | `application/json` |
  | `content-type` | `application/x-www-form-urlencoded` |
  | `user-agent` | `codex_cli_rs/0.170.0 (linux x86_64)` |
- **Request Body (`application/x-www-form-urlencoded`)**:
  | 字段名 | 值 / 格式 |
  | :--- | :--- |
  | `grant_type` | `authorization_code`（后续续期为 `refresh_token`） |
  | `client_id` | `app_EMoamEEZ73f0CkXaXp7hrann` |
  | `code` | `ac.1.<codex_auth_code>`（来自 **18**） |
  | `redirect_uri` | `http://localhost:1455/auth/callback` |
  | `code_verifier` | `<code_verifier_b64url>`（与 **14** 中 `code_challenge` 配对的本地明文） |
- **Response JSON**:
  ```json
  {
    "access_token": "<codex_access_token_jwt>",
    "refresh_token": "<codex_refresh_token>",
    "id_token": "<codex_id_token_jwt>",
    "expires_in": 864000,
    "scope": "openid profile email offline_access api.connectors.read api.connectors.invoke"
  }
  ```

---

## 附录 A：全量 Cookie 字典

### A.1 `auth.openai.com` 域 Cookie（16 项）

| Cookie 名称 | 格式 / 解码结构 | 作用说明 | 敏感级别 |
| :--- | :--- | :--- | :--- |
| `oai-did` | UUID v4 | 设备稳定标识（与 `device_id`、`sentinel.id` 一致） | 低 |
| `oaicom-stable-id` | UUID v4 | OpenAI 站点稳定标识 | 低 |
| `rg_context` | `prim` | 路由/区域上下文 | 低 |
| `iss_context` | `default` | 签发者上下文 | 低 |
| `__oailb` | ES256 JWT (`{host, iss:"edge-gateway", aud, exp, iat}`) | OpenAI 边缘负载均衡粘性会话 | 低 |
| `__cflb` / `_cfuvid` | 不透明字符串 | Cloudflare 负载均衡与访客标识 | 低 |
| `cf_clearance` / `__cf_bm` | 不透明字符串 | Cloudflare 反机器人校验凭证 | 中（风控门禁） |
| `oai-sc` | `0gAAAAAB...` | OpenAI Sentinel 风险/反机器人 Cookie（每步轮换） | 中（风控门禁） |
| `__Host-oai-initial-email-page` | 随机串 | 初始邮箱页令牌（对应初始 `openai-auth-page`） | 中 |
| `auth-session-minimized` | ES256 JWT (`{session_id, originator?, auth_session_logging_id, source_surface_stable_id, openai_client_id, app_name_enum, auth_session_affinity}`) | 服务端签名的登录状态机核心 Cookie | **高** |
| `auth-session-minimized-client-checksum` | `{"affinity":"base64({rc, cs, ws, wt})"}` | 客户端状态校验和，`ws` 随步骤递增（`0 → 1 → 3 → 4`） | 中 |
| `oai-client-auth-info` | `base64({last_login_identifier, last_login_strategy}).<ts>.<sig>` | 记录最近登录邮箱与策略（`auth0`） | 中 |
| `error_page_verifier` | `base64({id:<uuid>}).<ts>.<sig>` | 错误页防伪签名 Cookie | 低 |
| `__Host-unified_session_manifest` | ES256 JWT (`{version:3, iat, sessions:[{cookie_id, unified_session_id}]}`) | 统一会话清单（登录成功后填入 `us_*`） | **极高** |
| `__Host-usc_<cookie_id>` | ES256 JWT (`{type:"us", protocol_version:"3", cookie_id, encrypted_authenticated_data:"us_*", client_secret}`) | 统一会话认证凭据（跨端免密核心） | **极高** |
| `_dd_s` | `aid=...&rum=2&id=...&created=...&expire=...` | Datadog RUM 会话追踪 | 低 |

### A.2 `chatgpt.com` 域 Cookie（28 项）

| Cookie 名称 | 格式 / 示例值 | 作用说明 | 敏感级别 |
| :--- | :--- | :--- | :--- |
| `__Secure-next-auth.session-token.0` / `.1` | JWE (`dir` / `A256GCM`) 分片 | ChatGPT Web 核心登录态 Cookie | **极高** |
| `__Host-next-auth.csrf-token` | `<token_hex64>%7C<hash_hex64>` | NextAuth CSRF 防护（与 `csrfToken` 配对） | 中 |
| `__Secure-next-auth.callback-url` | `https%3A%2F%2Fchatgpt.com%2F` | NextAuth 登录回调地址 | 低 |
| `__Secure-next-auth.state` | JWE (`dir` / `A256GCM`) | NextAuth 服务端加密保存的 OAuth `state` | 高 |
| `__Secure-next-auth.pkce.code_verifier` | JWE (`dir` / `A256GCM`) | NextAuth 服务端加密保存的 PKCE `code_verifier` | 高 |
| `oai-did` / `oai-did-first-seen` | UUID / `v1.<uuid>.<ts>` | 设备 ID 及首次出现时间 | 低 |
| `oai-asli` | UUID | `auth_session_logging_id` | 低 |
| `oai-mweb-auth-pending` | `<uuid>.l.<sig>` | 登录进行中标记 | 低 |
| `oai-client-session-epoch` | UUID | 客户端会话纪元 | 低 |
| `oai-mweb-route` / `oai-mweb-origin` / `oai-hlib` | `1` / `1` / `true` | 前端路由与特性标记 | 低 |
| `oai-gn` | `<first_name>` | 用户名字展示缓存 | 低 |
| `_account` | `<org_workspace_id>` | 当前激活工作区 ID | 低 |
| `_account_residency_region` / `_account_is_fedramp` | `no_constraint` / `false` | 工作区数据驻留与合规标记 | 低 |
| `_puid` | `user-<id>:<ts>-<sig>` | 用户标识签名 Cookie | 中 |
| `oai-tpp-onboarding-completed-at` | URL 编码 JSON (`{userId, completedAt}`) | 新手引导完成时间 | 低 |
| `codex_sidebar_width` / `oai_pl_permission_state` | `340` / `disabled` 或 `not_set` | 前端界面偏好状态 | 低 |
| `cf_clearance` / `__cf_bm` / `_cfuvid` / `__cflb` / `__oailb` | 同 A.1 | Cloudflare 与边缘网关 Cookie | 中 |
| `oai-sc` | `0gAAAAAB...` | OpenAI Sentinel Cookie | 中 |
| `_dd_s_v2` | `aid=...&id=...&created=...&expire=...&c=0` | Datadog RUM v2 追踪 | 低 |

---

## 附录 B：全量 HTTP 请求头字典

| 分类 | Header 名称 | 出现步骤 | 作用与格式 |
| :--- | :--- | :--- | :--- |
| **认证与业务核心** | `authorization` | 13 | `Bearer <access_token_jwt>`（业务 API 鉴权） |
| | `chatgpt-account-id` | 13 | `<org_workspace_id>`（团队空间接口必带） |
| | `openai-auth-page` | 05, 06, 07, 08, 09, 10 | 每步轮换的页面令牌（取自上一步 `continue_url` 中 `auth_page`） |
| | `oai-device-id` / `oai-did` | 13 | `<oai_did>`（设备标识） |
| | `oai-language` | 13 | `en-US` |
| | `originator` | 13 | 客户端来源标识（如 `Codex Browser` / `codex_cli_rs`） |
| | `x-openai-codex-window-type` | 13 | `browser` |
| | `x-openai-web-frontend` | 13 | `codex_webview` |
| | `x-openai-rate-limit-join-workspace` | 13 | `1` |
| | `x-openai-rejoin-pro-cta` | 13 | `1` |
| **反机器人门禁** | `openai-sentinel-token` | 06, 07, 08, 10, 16 | OpenAI Sentinel 校验头（含 `flow`: `password_verify` / `verify_mfa` / `authorize_continue` 或 `{"e":...}`） |
| **流转与链路追踪** | `x-access-flow-invocation-id` | 06, 07, 08, 10, 16, 17 | 单次认证 API 调用 UUID |
| | `x-openai-document-navigation-id` | 06, 07, 08, 10, 16, 17 | 当前文档会话导航 UUID |
| | `traceparent` / `tracestate` | 07, 08, 09, 10, 16, 17 | W3C Trace Context（`tracestate: dd=s:1;o:rum`） |
| | `x-datadog-origin` / `parent-id` / `sampling-priority` / `trace-id` | 07, 08, 09, 10, 16, 17 | Datadog RUM 前端链路追踪头 |
| **标准浏览器 / Fetch** | `accept` / `accept-language` / `content-type` / `content-length` | 全程 | 内容协商与载荷类型 |
| | `origin` / `referer` / `cache-control` / `pragma` / `priority` | 全程 | 同源校验、缓存控制与 HTTP/2-3 优先级 |
| | `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform` | 全程 | Client Hints 浏览器标识 |
| | `sec-fetch-dest` / `sec-fetch-mode` / `sec-fetch-site` / `sec-fetch-user` | 全程 | Fetch 元数据（区分整页 `navigate` 与接口 `cors`） |
| | `upgrade-insecure-requests` / `user-agent` | 03, 11, 14, 15 / 全程 | 文档导航升级与浏览器 UA |
