# cfhost 待处理问题总清单(合并两份审计 + 串台/断联专项)

- 来源:`SECURITY_REVIEW.md`(下称"报告 A",编号 A1~A11)、`CFHOST_SECURITY_STABILITY_AUDIT.md`(下称"报告 B",编号 CF-01~CF-11)、本次对串台/断联/崩溃路径的专项复查(编号 X1~X9)。
- 状态:全部为静态分析结论,尚未改代码,尚未做动态验证。
- 目标:安全、稳定、业务逻辑完整,不崩溃、不断联、不串台。

## 0. 串台专项结论(用户 A 的话发到用户 B 的房间 / 客服回复 A 却被 B 看到)

**服务端路由本身是可靠的**,不存在直接串台路径:

- ChatHub 是单实例(`idFromName('main')`),不存在多实例数据分裂。
- 访客发消息时,`roomId` 来自已验证的 `visitorId`;客户端传的 `senderId` / `senderType` 被忽略;传入的 `roomId` 必须通过 `getOwnedRoom(roomId, visitorId)` 校验([hub.ts](worker/src/hub.ts#L640) 附近)。
- 访客只收到绑定到自己房间的广播(`emitToRoom` 按 `att.visitor.roomId` 过滤);agent 收到所有房间的消息是设计如此,由客户端按 `roomId` 过滤。
- 历史记录、图片访问都在 ChatHub 内按"房间所属访客"判权。

**真正可能导致串台或错位的是下面这些点**:

| 风险点 | 说明 | 对应条目 |
|---|---|---|
| 身份可被冒领 | `visitorId` 是唯一凭证,`/visitor-auth` 对无凭证请求直接采用请求体里的 `visitorId` 并签发 token。拿到别人的 `visitorId` 就能进入其房间、读历史、以其名义发言 | CF-04 / A5 |
| 伪造 agent JWT | Cookie 与 JWT 同密钥时可伪造 agent token,绕过房间权限读取任意房间历史、图片 | A1 |
| 旧 agent 凭证仍有效 | 注销、改密、被踢后,旧 JWT 仍能读历史和图片,旧 WebSocket 仍能收发 | CF-02 / CF-03 / A2 / A4 |
| agent 端异步取值 | `sendMessage` 在 `await` 翻译之后才读取 `props.roomId`,图片上传同理。翻译或压缩期间房间参数变化(路由复用、浏览器前进后退),消息会发到新房间 | X1 |
| agent 端历史竞态 | 切换房间时,上一个房间的 `loadHistory` 响应晚到,会把旧房间的消息、访客名、页面、状态覆盖到新房间视图 | X2 |
| agent 输入框未随房间重置 | 房间参数变化时,`input` 草稿没有清空,可能被发到另一个房间 | X1 |
| 同浏览器多访客身份 | 签名 Cookie(24 小时)与 token 可能指向不同访客,当前处理会导致断联而不是串台,但修复时不能改成"任选其一"而引入串台 | X3 |

## 1. P0:必须先处理(安全 + 串台 + 断联)

### 认证与会话

| 编号 | 问题 | 来源 | 处理方案 |
|---|---|---|---|
| P0-1 | Cookie 与 JWT 共用密钥,可伪造 agent JWT | A1 / CF-09 | 强制独立 `COOKIE_SECRET`,去掉回退;JWT 加 `typ=agent`、`aud`、`exp` 校验;Cookie 签名内容加域前缀 |
| P0-2 | history / files / upload 只验 JWT,不验 session | CF-03 / A2 | 抽出统一的 agent 校验(JWT + `verifyAgentSession`),三处都使用;agent JWT 有效期从 10 年缩短,session 增加空闲 TTL |
| P0-3 | session 失效后 agent WebSocket 继续可用 | CF-02 / A4 | `endSession`、改密、顶号时服务端主动 `ws.close()`;agent 每个事件执行前复核 session(可用短 TTL 缓存) |
| P0-4 | `/visitor-auth` 接受请求体中的任意 `visitorId` | CF-04 / A5 | 无有效 Cookie / token 时一律生成新 UUID。**业务兼容**:widget 有 30 天持久会话(`SESSION_TTL_MS`),而 visitor JWT 只有 7 天;需把 visitor JWT 有效期改为 30 天并支持续签,否则持久会话会丢历史 |
| P0-5 | 签名 Cookie 没有过期时间 | A1 | Cookie 值内嵌 `exp`,校验时检查 |

### 串台与断联

| 编号 | 问题 | 来源 | 处理方案 |
|---|---|---|---|
| P0-6 | agent 发送时 `roomId` 在 `await` 之后读取 | X1 | `sendMessage`、`handleImageUpload` 入口处先固定 `const roomId = props.roomId`;`router-view` 以 `$route.fullPath` 作 `key`,保证换房间时重建组件,输入框、翻译状态一并重置 |
| P0-7 | 历史请求竞态覆盖新房间 | X2 | `loadHistory` / `loadOlderHistory` 发起时记录 `roomId`,响应回来后若与当前 `props.roomId` 不一致则丢弃;历史返回后按 `messageId` 合并实时消息,避免丢失或重复 |
| P0-8 | `visitor-join` 中 Cookie 优先于 token,二者不一致即判失败,随后 10 秒超时被关闭,客户端无限重连 | X3 / A11 | 只要 claimed `visitorId` 等于 Cookie 或 token 任意一个已验证 ID 就通过(与 HTTP 侧 `verifiedVisitorIds` 一致);失败时明确关闭并返回错误码,客户端收到后重新走 `/visitor-auth`,不要空转重连 |
| P0-9 | 客服端卸载房间时 `socket.off('receive-message')` 会删掉 [socket.js](client-agent/src/socket.js#L221) 里的全局声音处理器 | X4 | 改为保存具名处理函数,`socket.off('receive-message', handler)` |
| P0-10 | 客服端不处理服务端的 `Invalid token`,停在登录态页面没有实时数据 | A11 | 处理 `error: 'Invalid token'`,清理本地状态并跳转登录页 |
| P0-11 | [rt-client.js](shared/rt-client.js) 在触发 `connect` 之前先冲刷发送缓冲区,缓冲的 `send-message` 先于 `agent-login` / `visitor-join` 到达,被判 `Unauthenticated`;断线时挂起的 ack 回调被丢弃 | A11 | 先触发 `connect`(让业务层先发登录事件),再冲刷缓冲区;断线时对挂起的 ack 回调返回 `{success:false, error:'disconnected'}` |

### 滥用与资源耗尽

| 编号 | 问题 | 来源 | 处理方案 |
|---|---|---|---|
| P0-12 | WebSocket 无事件级限流、无连接数限制 | CF-01 / A5 | 升级阶段按 IP 走 `RateLimiter`;连接内按事件类型做令牌桶(消息、登录、页面变化、已读、房间列表),超限先返回错误,再关闭;未认证连接限制消息数;单 `visitorId` 限制并发连接 |
| P0-13 | 消息长度无上限(可达 256K),并经房间列表广播给所有 agent | CF-11 / A6 | 文本上限(建议 2000~4000 字符);widget 与 agent 输入框加 `maxlength`;房间列表的 `lastMessage` 在 SQL 里截断 |
| P0-14 | `visitor-auth` 无限流,可免费生成无限访客与房间 | A5 | 按 IP 限流;新访客首次发消息才建房(当前已是),并对 IP 和访客的建房、消息频率设限;定期清理无消息的空房间 |
| P0-15 | 访客可控的 `currentPage` 作为 `href`(存储型 XSS) | A3 | 服务端保存前校验协议只允许 `http:` / `https:`;[ChatRoom.vue](client-agent/src/views/ChatRoom.vue#L10) 渲染前同样校验;Agent 站点增加 CSP |

## 2. P1:高优先级

| 编号 | 问题 | 来源 | 处理方案 |
|---|---|---|---|
| P1-1 | `getRoomList` 无 LIMIT,重复子查询,每次消息都对每个 agent 重算 | A6 | 合并"最后一条消息"子查询;加 LIMIT 与分页;广播合并窗口加大(如 200ms),`visitor-page-change` 限频 |
| P1-2 | 登录限流:成功登录也计数,办公室共用 IP 互相锁死;IPv6 可轮换绕过;无账号维度;用户名枚举时间差 | A7 | 仅统计失败;IPv6 按 /64 聚合;增加按账号限流;用户名不存在时也跑一次假 bcrypt;提高密码最小长度 |
| P1-3 | 上传:限流在认证之前;R2 不清理;自动建房;元数据失败回滚也可能失败;图片消息未校验文件属于当前房间 | A8 | 先认证再限流;R2 配置生命周期规则并定期对账孤儿对象;`send-message` 校验 `upload_files.roomId` 等于目标房间 |
| P1-4 | 管理导入:无请求体、字段、总量限制,`INSERT OR REPLACE` 可覆盖 agent 密码哈希 | CF-05 / A11 | 限制请求体大小与字段长度、总字符数;对导入数据做类型校验;不用时删除 `ADMIN_TOKEN` |
| P1-5 | 管理文件上传:无大小、类型、魔数校验 | CF-06 | 复用 `sniffImage`,限制 Content-Length |
| P1-6 | 管理接口无失败限流 | CF-10 / A11 | 增加限流;用 Cloudflare Access 或 IP 白名单保护 `/api/admin/*` |
| P1-7 | `ALLOWED_ORIGINS` 为空时完全开放并向任意 Origin 反射凭据 | CF-07 / A9 | 默认拒绝;只有显式 `ALLOW_ANY_ORIGIN=true`(开发)才放开;收窄 `*.efxopen.com` 通配 |
| P1-8 | 状态变更接口无 Origin 校验(`/login`、`/logout`、`/change-password`、`PUT /knowledge-base`) | A9 | 统一加 Origin 校验,不再依赖 Hono 对 Content-Type 的宽松解析 |
| P1-9 | `getClientIp` 回退到 `x-forwarded-for` / `unknown` | CF-08 | 只信任 `cf-connecting-ip`;缺失时拒绝请求,不要共用 `unknown` 桶 |
| P1-10 | 知识库整体替换同步事务可能长时间阻塞 DO;无请求体上限;后写覆盖先写 | A10 | 限制总条数和请求体大小;加版本号做乐观锁 |

## 3. P2:稳定性与加固

| 编号 | 问题 | 来源 | 处理方案 |
|---|---|---|---|
| P2-1 | Bark 推送:长消息超出 URL 长度而失败;每条访客消息都推送,可被刷 | CF-01 / A11 | 推送内容截断到约 100 字符;对同一房间推送做去抖(如 30 秒一条) |
| P2-2 | widget 收到更高 `APP_VERSION` 就刷新宿主网站整页 | A11 | 改为只重新加载 widget 脚本,不要 `location.reload`;或仅在聊天窗口关闭且输入为空时刷新 |
| P2-3 | 时间格式混用(`CURRENT_TIMESTAMP` 与 ISO),字符串比较可能错序 | A11 | 新增迁移统一为 ISO;`getRoomList` 的 `datetime(doneAt)` 比较保持兼容 |
| P2-4 | `mark-read` / `join-room` 可写入任意长度的 `roomId` | A11 | 校验 `ROOM_ID_PATTERN` 并确认房间存在 |
| P2-5 | `/logout` 不校验 session 归属 | A11 | 同时验证 agent JWT 与 sessionId 属于同一 agent |
| P2-6 | `?vt=` 把访客 token 放进图片 URL,会进日志与 Referer | A11 | 图片加 `Referrer-Policy: no-referrer`;长期改为 Cookie / 短期签名 URL |
| P2-7 | 翻译接口无调用量限制 | A11 | 按 agent 做限流与日调用上限 |
| P2-8 | JSON 请求体读取无大小限制(`/login`、`/import` 等) | A11 | 读取前检查 `Content-Length`,超限返回 413 |
| P2-9 | agent 的 `senderName` 由客户端提供,可冒用其他客服的名字 | X5 | 一律以服务端数据库中的 `agents.name` 为准 |
| P2-10 | `ck.agentToken` 未经校验就存入 WebSocket attachment,而 attachment 上限 2KB,超长 Cookie 会让升级请求抛异常 | X6 | 只在 `agent-login` 时读取,或截断/丢弃超长值,并 try/catch `setAtt` |
| P2-11 | 单个 ChatHub 是全部流量的单点;访客页面访问与 WS 连接都落到它 | A5 | 长期:把 `visitor-auth` 的无状态部分(签发 token)放在 Worker 本地,避免每次访问都走 DO;监控 DO 请求量 |
| P2-12 | 密钥与部署配置缺少启动检查 | CF-09 | Worker 入口检查 `JWT_SECRET`、`COOKIE_SECRET` 存在、足够长且互不相同,缺失时返回 500 并记录日志 |

## 4. 修复时必须保持的业务行为(回归检查清单)

1. 同一访客多标签页共用一个房间,消息实时同步。
2. 访客刷新页面、30 天内带"保留会话"返回,仍然看到自己的历史,且仍在同一个房间。
3. 客服回复只会出现在该房间的访客一侧;其他访客绝不会收到。
4. 客服在多个设备登录:同设备类型旧会话被踢并真正断开;不同设备类型并存。
5. 客服标记"已完成"后 24 小时内仍可见;访客再发消息自动重新激活。
6. 图片:访客只能看自己房间的图,客服能看全部;已注销客服不能看。
7. widget 在白名单站点正常,在其他站点被拒绝。
8. 断线后自动重连,重连后先登录再补发缓冲消息,不丢也不重复。
9. 版本升级时 widget 和客服端平滑更新,不打断访客在宿主站上的操作。
10. 已有 `scripts/smoke.mjs` 要扩展:覆盖跨房间越权发送、旧 session 访问历史、WS 限流、cookie 与 token 不一致等用例。

## 5. 建议的实施顺序

1. P0-1 ~ P0-5(认证与会话)+ P0-15(XSS),一次发布。
2. P0-6 ~ P0-11(串台与断联),客户端和服务端同步发布(注意 widget 缓存时间:`embed.js` 300 秒、`rt-client.js` 86400 秒,需要升级 `APP_VERSION` 并给 `rt-client.js` 加版本参数)。
3. P0-12 ~ P0-14(限流与长度限制)。
4. P1 全部,再 P2。
5. 每一步都跑扩展后的 `smoke.mjs`,并对生产做一次 `prod-check.mjs` / `origin-check.mjs`。

## 6. 实施状态(已完成修复)

已在代码中完成并通过类型检查、本地端到端冒烟测试(`scripts/smoke.mjs`,全部通过)、`origin-check.mjs` 以及客户端构建。**尚未部署到生产。**

- P0-1~P0-5:Cookie 签名密钥派生 + 域前缀 + 过期时间;JWT 强制 `exp`;history / files / upload 统一校验 JWT + 存活 session(60 天滑动空闲过期);session 失效、登出、改密、顶号时服务端主动关闭 WebSocket,agent 每个事件复核 session;`/visitor-auth` 不再采用客户端提交的 `visitorId`,访客 JWT 改 30 天并在每次调用时续签。
- P0-6~P0-11:客服端固定 `roomId`、历史请求竞态丢弃、`router-view` 以路径作 key、重连后补拉漏掉的消息、具名监听器、`Invalid token` 处理;`visitor-join` 接受 Cookie 或 token 任一证明并在失败时通知 widget 重新认证;rt-client 先触发 `connect` 再冲刷缓冲区、断线时让未完成的 ack 失败、4001/4002 不再重连。
- P0-12~P0-15:WebSocket 按连接/按访客令牌桶限流、升级请求按 IP 限流、单访客连接数上限;文本上限 4000 字符;`visitor-auth` 限流;页面 URL 只接受 http(s),客服端同样校验并增加 CSP。
- P1:`getRoomList` 单次查询 + LIMIT 300 + 预览截断;登录仅统计失败(IP 20 / 账号 30,IPv6 按 /64),不存在的用户也跑 bcrypt;上传先认证再限流、图片只能发到所属房间;管理接口加失败限流、请求体/字段/文件限制与图片魔数校验;`ALLOWED_ORIGINS` 为空时拒绝(本地用 `ALLOW_ANY_ORIGIN=true`);agent 专用写接口强制同源;只信任 `cf-connecting-ip`;知识库加乐观锁版本与大小限制。
- P2:Bark 截断 + 同房间 15 秒去抖;widget 不再刷新宿主页面;时间统一为 ISO(迁移 v2);`mark-read` / `join-room` 校验房间;`/logout` 校验 session 归属;`Referrer-Policy: no-referrer`;翻译限流;JSON 请求体大小上限;agent 发言名称取自服务端账号;启动时检查 `JWT_SECRET`。

未通过代码解决、需要你在 Cloudflare 侧或配置中处理:

1. ~~R2 生命周期规则(清理旧图片)和孤儿对象对账~~:已在 `chatfile` 桶上配置 R2 自带的生命周期规则 `expire-chat-images-720d`(对象 720 天后过期,不消耗 Worker 额度,立即生效、无需部署)。过期图片在历史消息里无法加载,数据库里的元数据行保留(占用极小)。孤儿对象(仅在元数据写入失败时出现)极少,未做专门清理。
2. `ALLOWED_ORIGINS` 中的 `https://*.efxopen.com` 通配:建议改为明确列出允许嵌入的站点。
3. ChatHub 仍是单实例(架构限制),建议在 Cloudflare 控制台监控其请求量并配置 WAF / Bot 防护。
4. 管理接口建议再加 Cloudflare Access 或 IP 白名单;不用时删除 `ADMIN_TOKEN` secret。

部署注意:
- 发布 Worker 后,所有访客的旧 `visitorAuth` Cookie 失效(格式变更),靠 token 恢复身份,历史不受影响;已过期的旧访客 token 无法再续用(这是有意的)。
- 已登录客服不受影响(旧 JWT 仍含 `exp`),但需要有存活的 session;超过 60 天未使用的 session 会被要求重新登录。
- 客服端新增 CSP,首次部署后请在浏览器控制台确认没有被拦截的资源。
- 先部署 Worker,再部署 client-agent 和 embed_widget(新前端依赖 `auth-failed` 事件与知识库 `version` 字段,旧前端与新 Worker 兼容)。
