# cfhost 稳定性与安全性审查报告

- 审查日期:2026-10-20
- 范围:`cfhost/worker`、`cfhost/client-agent`、`cfhost/embed_widget`、`cfhost/shared`
- 方法:静态代码阅读。未修改任何代码,未实际复现漏洞。严重度按代码逻辑推断,第 1 条的利用条件需确认线上配置。

## 摘要

| 编号 | 严重度 | 问题 | 位置 |
|---|---|---|---|
| 1 | 高 | Cookie 与 JWT 共用密钥,可伪造 agent JWT | `types.ts`、`lib/cookies.ts`、`routes/auth.ts`、`lib/jwt.ts` |
| 2 | 高 | agent HTTP 接口只验 JWT 不验 session | `routes/content.ts`、`routes/files.ts`、`routes/upload.ts` |
| 3 | 高 | 访客控制的 `currentPage` 作为 `href`,存储型 XSS | `client-agent/src/views/ChatRoom.vue` |
| 4 | 高 | 会话失效后 agent WebSocket 不会被服务端断开 | `hub.ts` |
| 5 | 中 | 访客身份可免费无限生成,无限流 | `routes/auth.ts`、`hub.ts` |
| 6 | 中 | 房间列表广播放大,消息无长度限制 | `hub.ts`、`db/store.ts` |
| 7 | 中 | 登录限流既误伤又可绕过 | `routes/auth.ts`、`rate-limiter.ts` |
| 8 | 中 | 上传相关滥用与一致性问题 | `routes/upload.ts`、`hub.ts` |
| 9 | 中 | CORS 与 CSRF 面偏大 | `index.ts`、`lib/origin.ts`、`wrangler.jsonc` |
| 10 | 中 | 知识库整体替换阻塞 DO | `db/store.ts`、`routes/content.ts` |
| 11 | 低 | 其他稳定性与加固项 | 见下文 |

---

## 高危

### 1. visitorAuth Cookie 与 JWT 共用密钥,可伪造 agent JWT

- 位置:[types.ts](worker/src/types.ts#L57)、[lib/cookies.ts](worker/src/lib/cookies.ts)、[routes/auth.ts](worker/src/routes/auth.ts)(`/visitor-auth`)、[lib/jwt.ts](worker/src/lib/jwt.ts)
- 前提:线上未设置 `COOKIE_SECRET`。`cookieSecret()` 会回退到 `JWT_SECRET`,Cookie 签名与 JWT 签名使用同一个 HMAC-SHA256 密钥。
- 原理:
  - `/api/visitor-auth` 会为请求体里客户端自选的 `visitorId`(不超过 100 字符)签发 Cookie,格式为 `<encodeURIComponent(visitorId)>.<sig>`。
  - 攻击者把 `visitorId` 设为 `base64url({"alg":"HS256"}) + "." + base64url({"agentId":"<uuid>"})`,总长约 88 字符。`encodeURIComponent` 不会改动 base64url 字符和 `.`。
  - 返回的 Cookie 值正好是一个合法的 JWT,签名有效,且没有 `exp`。
- agentId 的获取:agent 回复的消息里带 `senderId`,访客在自己的房间里能看到。
- 影响:伪造 token 过不了 `authenticateAgent`(它还要求有效 session),但能通过所有"只验 JWT"的入口(见第 2 条)。实际能读到什么取决于攻击者能否拿到 roomId 或文件 key(均为随机 UUID)。
- `originGuard` 只校验 Origin 头,非浏览器客户端可以伪造,挡不住。
- 建议:
  - 必须单独设置 `COOKIE_SECRET`,并去掉回退逻辑。
  - JWT 增加 `typ` / `aud` / `exp` 校验。
  - Cookie 签名内容加域前缀(domain separation)。

### 2. agent HTTP 接口只验 JWT,不验 session

- 位置:[routes/content.ts](worker/src/routes/content.ts)(history)、[routes/files.ts](worker/src/routes/files.ts)、[routes/upload.ts](worker/src/routes/upload.ts)
- 这三处只调用 `verifyAgentToken`,没有调用 `verifyAgentSession`。
- agent JWT 有效期 3650 天([lib/jwt.ts](worker/src/lib/jwt.ts#L49)),Cookie 400 天,session 没有空闲超时,`lastActiveAt` 不参与过期判断。
- 影响:登出、被踢下线、改密码之后,旧 token 仍可读取全部历史消息和图片,并以 agent 身份上传。
- 建议:三处统一走 `authenticateAgent` 的校验逻辑;缩短 JWT 有效期;session 加 TTL。

### 3. 访客控制的 `currentPage` 直接作为 `href`(存储型 XSS)

- 位置:[ChatRoom.vue](client-agent/src/views/ChatRoom.vue#L10):`<a :href="currentPage" target="_blank">`
- 服务端对 `currentPage` 只做 trim 和截取 500 字符([hub.ts](worker/src/hub.ts#L476) 附近),不校验协议。
- 访客发送 `javascript:...` 后,客服点击页头链接即执行脚本,脚本可借助客服 Cookie 调用 API 和 WebSocket,读取所有会话。
- [client-agent/public/_headers](client-agent/public/_headers) 中没有 CSP,没有缓解。
- 建议:服务端与客户端都只接受 `http:` / `https:`;为 Agent 站点增加 CSP。

### 4. 会话失效后 agent WebSocket 不会被服务端断开

- 位置:[hub.ts](worker/src/hub.ts#L91)(`endSession`)、[hub.ts](worker/src/hub.ts#L318)(`kickSessions`)
- `/logout`、改密码、被顶号时,服务端只下发 `force-logout` 事件,不关闭 socket,后续事件也不再校验 session。
- 被踢下线的恶意客户端可忽略该事件,继续收发所有房间的消息。
- 建议:踢线时服务端主动 `ws.close()`;关键事件处理前复核 session。

---

## 中危

### 5. 访客身份可免费无限生成,无限流

- `/api/visitor-auth` 为任意 `visitorId` 发 Cookie 与 7 天 JWT,无限流,无前置凭证。
- 过期 token 会回退到请求体里的 `visitorId`,token 过期没有实际意义,`visitorId` 本身就是长期凭证。
- `/ws` 连接、`visitor-join`、`send-message`、`visitor-page-change`、`mark-read` 均无限流与连接数上限。
- 攻击者更换 `visitorId` 即可不断创建房间,房间数据永不清理。
- 每条访客消息都会推送 Bark,可被用来刷客服手机。
- 所有访客页面访问与 WS 连接都落到唯一的 ChatHub,它既是单点也是容量瓶颈。
- 建议:对 `visitor-auth` / WS 升级 / 消息发送按 IP 与 visitorId 限流;设置单 IP 连接上限;清理长期无活动的空房间。

### 6. 房间列表广播放大,消息无长度限制

- 位置:[hub.ts](worker/src/hub.ts#L24)、[hub.ts](worker/src/hub.ts#L411)(`sendRoomLists`)、[db/store.ts](worker/src/db/store.ts#L291)(`getRoomList`)
- `visitor-page-change` 与 `send-message` 都会触发全员房间列表广播(50ms 合并),每个 agent 重算一次。
- `getRoomList` 无 LIMIT,每个房间 5 个相关子查询,其中 3 个是重复的"最后一条消息"。
- 房间列表带完整 `lastMessage`。单帧上限 256K 字符,消息内容没有单独长度限制:一条 250K 字符的消息会随每次广播发给所有 agent。
- 垃圾房间越多,读取行数、计费和 CPU 越高。
- 建议:消息内容限制在合理长度(如 2000 字符);`lastMessage` 在 SQL 中截断;`getRoomList` 加 LIMIT 并合并子查询;对 `visitor-page-change` 限频。

### 7. 登录限流既误伤又可绕过

- 位置:[routes/auth.ts](worker/src/routes/auth.ts)(`/login`)、[rate-limiter.ts](worker/src/rate-limiter.ts)
- 每 IP 15 分钟 5 次,成功登录也计入。办公室多个客服共用出口 IP 时会互相锁死。
- 按完整 IPv6 地址计数,攻击者在 /64 内换地址即可绕过。
- 没有按账号的锁定或限流,分布式爆破不受限制。
- 用户名不存在时跳过 bcrypt,响应时间差可枚举用户名。
- 最短密码仅 6 位;`/login` 读取 JSON 无大小上限。
- 建议:仅统计失败次数;IPv6 按 /64 聚合;增加按账号的限流;用户名不存在时也执行一次假 bcrypt;提高密码最小长度。

### 8. 上传相关滥用与一致性问题

- 位置:[routes/upload.ts](worker/src/routes/upload.ts#L33)、[hub.ts](worker/src/hub.ts#L146)(`authorizeUpload`)
- 上传限流在身份校验之前,未认证者可耗尽同 IP 的额度,影响同出口 IP 的客服。
- R2 对象永不清理。访客可每 15 分钟传 20 张最大 5MB 的图,持续占用存储。
- 访客无房间时上传会自动建房,又是一个免费建房入口。
- 先写 R2 再写元数据,元数据失败时才回滚 R2;回滚也失败会留下孤儿文件。
- 发送图片消息只校验文件存在于 `upload_files`,没有校验它属于当前房间。
- 建议:先认证再限流;R2 配置生命周期规则;定期对账孤儿对象;图片消息校验文件所属房间。

### 9. CORS 与 CSRF 面偏大

- 位置:[index.ts](worker/src/index.ts)、[lib/origin.ts](worker/src/lib/origin.ts)、[wrangler.jsonc](worker/wrangler.jsonc)
- `ALLOWED_ORIGINS` 含 `https://*.efxopen.com`,且 CORS 允许带凭据。任何 efxopen.com 子域(包括嵌入了 widget 的站点)出现 XSS 或子域接管,就能用客服 Cookie 调 API。
- `/login`、`/logout`、`/change-password`、`PUT /knowledge-base` 没有 `originGuard`。Hono 的 `c.req.json()` 不检查 Content-Type,`text/plain` 简单请求可绕过预检,目前只靠 SameSite=Lax 防护。
- `ALLOWED_ORIGINS` 留空时为"不限制",并会向任意 Origin 反射 CORS 凭据,属于配置风险。
- 建议:状态变更接口统一加 Origin 校验;空配置时默认拒绝;收窄通配子域。

### 10. 知识库整体替换会长时间阻塞 DO

- 位置:[db/store.ts](worker/src/db/store.ts#L346)、[routes/content.ts](worker/src/routes/content.ts)
- 最多 100 类 × 500 条,在同步事务里逐行 INSERT,期间整个 ChatHub 的实时通信被阻塞。
- 请求体无大小限制;多人同时编辑为后写覆盖先写,无版本控制。
- 建议:限制总条数与请求体大小;改为增量更新或加版本号(乐观锁)。

---

## 低危与稳定性

- **Bark 推送**:访客消息(最长 256K)被放进 URL 路径发送([hub.ts](worker/src/hub.ts#L761)),超长消息的通知会静默失败。
- **重连时序**:[shared/rt-client.js](shared/rt-client.js) 在 `onopen` 中先冲刷发送缓冲区,再触发 `connect`。缓冲的 `send-message` 会先于 `agent-login` / `visitor-join` 到达,被判为 `Unauthenticated`。断线时挂起的 ack 回调被直接丢弃,UI 可能一直等待。
- **客服端错误处理不匹配**:服务端对失效 token 发 `error: 'Invalid token'`,客户端只处理 `'Authentication error'`([socket.js](client-agent/src/socket.js#L173)),结果停在登录态页面,无实时数据也不跳转。
- **整页刷新**:widget 收到更高的 `APP_VERSION` 时会 `window.location.reload(true)` 刷新宿主网站整页,每次发版都会打断访客在宿主站上正在填写的内容。
- **`visitor-join` 身份冲突**:Cookie 中的 `visitorId` 优先于 token,二者不一致(Cookie 1 天、token 7 天)时直接判定验证失败。
- **时间格式**:`CURRENT_TIMESTAMP`(`YYYY-MM-DD HH:MM:SS`)与 ISO 格式混用,按字符串比较在同一天内会错序,历史迁移数据最易出问题。
- **任意 roomId 写入**:`mark-read`、`join-room` 会把任意长度的 `roomId` 写入 `room_reads`,访客和客服都可用来膨胀存储。
- **`/api/logout`** 不校验 session 归属,持有 sessionId 即可将其登出。
- **`?vt=`** 使访客 token 出现在图片 URL 中,会进入日志和 Referer。
- **翻译接口** 对已登录客服无调用量上限,Google API Key 被滥用时没有保护。
- **管理接口**:`/api/admin/*` 无限流;`import` 使用 `INSERT OR REPLACE`,可覆盖 agent 的密码哈希;静态 `ADMIN_TOKEN` 泄露等同完全接管,不用时应删除该 secret。
- **请求体大小**:`/login`、`/import` 等接口读取 JSON 时无大小上限。

---

## 建议处理顺序

1. 确认线上是否已设置独立的 `COOKIE_SECRET`,并修复第 1、2、3、4 条。
2. 给 `/api/visitor-auth`、WS 连接、`send-message`、`visitor-page-change` 加限流,并限制消息长度(第 5、6 条)。
3. 优化 `getRoomList`(LIMIT、合并子查询),重做登录限流策略(第 6、7 条)。
4. 处理上传、CORS/CSRF、知识库更新(第 8、9、10 条),再逐项清理低危项。
