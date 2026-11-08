# CFHost 第二轮安全与稳定性复审报告

**复审日期：** 2026-10-20  
**复审范围：** `cfhost/worker` 当前代码、Durable Object、WebSocket、HTTP API、认证授权、上传、文件访问、管理接口及部署配置  
**复审方式：** 只读静态代码审查；未修改业务代码，未进行真实攻击和压力测试

## 一、执行摘要

本轮复审针对上一版报告提出的问题逐项核对。上一轮的主要问题已经完成修复或明显加固：

- WebSocket 增加了连接级和事件级 Token Bucket 限流。
- WebSocket 增加了连接风暴限制。
- Agent Session 注销、改密、异地登录后会关闭旧连接。
- WebSocket 每个 Agent 事件前重新检查 Session 是否有效。
- REST Agent 数据访问改为 JWT + Session 双重校验。
- `/visitor-auth` 不再采纳无凭证的客户端 `visitorId`。
- 管理接口增加了请求体、字段、文件大小及图片内容检查。
- `ALLOWED_ORIGINS` 改为默认拒绝。
- 限流只信任 Cloudflare 的 `cf-connecting-ip`。
- Cookie 签名增加了独立用途派生、过期时间和版本前缀。
- 文本消息、访客消息频率、上传频率均增加限制。
- 登录增加了统一失败耗时、按 IP/账号失败限流。

当前没有发现新的高危或严重漏洞。仍发现以下低风险问题和稳定性改进项：

1. 访客发送限流 Bucket 在大量持续活跃访客下可能持续占用内存。
2. 翻译上游错误响应正文被写入日志，存在低概率敏感信息泄露风险。
3. Visitor Token 仍支持通过 `?vt=` 查询参数传输，可能进入浏览器历史、代理日志或共享链接。
4. Agent Session 空闲 TTL 为 60 天，安全性和资源回收较宽松。
5. 部分索引和长期运行内存结构仍建议通过监控和压力测试验证。

**复审结论：** 当前 CFHost 已达到可以继续运行的安全基线，评级为“良好偏优秀”；建议在正式高暴露生产环境中继续处理低风险项，并进行动态压力测试。

---

# 二、上一轮问题复核

## 1. WebSocket 事件限流

**状态：已修复**  
**当前风险：低**

相关位置：

- [WebSocket 入口和帧限制](cfhost/worker/src/hub.ts#L329-L387)
- [事件分发及分类限流](cfhost/worker/src/hub.ts#L430-L495)
- [连接风暴限制](cfhost/worker/src/index.ts#L57-L74)

当前实现包含：

- 每帧最大约 256 KB。
- 每个连接的全局帧频率限制。
- `agent-login`、`visitor-join` 的认证限流。
- 房间列表、已读、状态更新等重操作限流。
- `send-message` 独立限流。
- 违规累计后关闭连接。
- `/ws` 按 Cloudflare 客户端地址限制升级频率。

剩余注意事项：连接级限流无法单独限制一个攻击者创建大量不同连接的情况，仍需要依赖 `/ws` 升级限流、Cloudflare 防护和运行监控共同处理。

---

## 2. Session 撤销后的 WebSocket 连接

**状态：已修复**  
**当前风险：低**

相关位置：

- [Session 有效性检查及注销](cfhost/worker/src/hub.ts#L130-L169)
- [旧连接关闭](cfhost/worker/src/hub.ts#L312-L337)
- [每个事件前的 Session 复核](cfhost/worker/src/hub.ts#L479-L495)
- [HTTP 注销调用](cfhost/worker/src/routes/auth.ts#L72-L84)

当前实现同时具备：

- 注销时删除当前 Session 并关闭对应 Socket。
- 异地登录或修改密码时关闭旧 Session 的 Socket。
- Agent WebSocket 每个事件前检查 Session 是否过期或被删除。
- 空闲 Session 超过 TTL 后删除。

上一轮“撤销 Session 后旧连接仍可操作”的问题已解决。

---

## 3. REST Agent API 绕过 Session

**状态：已修复**  
**当前风险：低**

相关位置：

- [统一 Agent 解析](cfhost/worker/src/lib/auth.ts#L43-L68)
- [历史记录授权](cfhost/worker/src/routes/content.ts#L12-L33)
- [上传授权](cfhost/worker/src/routes/upload.ts#L31-L44)
- [文件访问授权](cfhost/worker/src/routes/files.ts#L20-L29)

历史记录、上传和文件访问已从单纯验证 JWT 改为调用 `resolveAgent()`，同时验证：

1. JWT 有效。
2. Agent Session ID 存在。
3. Session 属于该 Agent。
4. Session 未超过空闲 TTL。

旧 JWT 在 Session 被撤销后不能继续获得 Agent 权限。

---

## 4. `/visitor-auth` 接受任意客户端 `visitorId`

**状态：已修复**  
**当前风险：低**

相关位置：

- [访客认证流程](cfhost/worker/src/routes/auth.ts#L137-L180)
- [访客 Token 解析](cfhost/worker/src/lib/auth.ts#L25-L40)

当前无有效签名 Cookie 或 Visitor JWT 时，服务端会生成新的随机 UUID，不再采纳请求体中的任意 `visitorId`。因此，单纯知道或猜测某个 Visitor ID 已不能直接取得该身份。

此外，首次创建访客身份和 `/visitor-auth` 请求均已增加限流。

仍建议后续避免在 URL 中传输 Visitor Token，见本报告 CF-02。

---

## 5. 管理接口资源限制

**状态：已修复**  
**当前风险：低到中

相关位置：

- [管理接口认证和限流](cfhost/worker/src/routes/admin.ts#L20-L51)
- [创建 Agent 请求限制](cfhost/worker/src/routes/admin.ts#L53-L70)
- [批量导入限制](cfhost/worker/src/routes/admin.ts#L72-L98)
- [管理文件限制](cfhost/worker/src/routes/admin.ts#L100-L131)

当前已增加：

- Agent 创建请求体上限。
- 导入请求体上限 16 MB。
- 单次导入最多 1000 行。
- 单字段最大长度限制。
- 管理文件 Content-Length 和实际读取大小限制。
- 管理文件图片魔数检查。
- 管理接口失败限流。

仍建议管理接口使用 Cloudflare Access、IP 白名单或独立管理域名，不能只依赖 `ADMIN_TOKEN` 暴露在公网。

---

## 6. Origin 默认开放问题

**状态：已修复**  
**当前风险：低**

相关位置：

- [Origin 校验](cfhost/worker/src/lib/origin.ts#L25-L52)
- [Worker 统一配置检查和 Origin 应用](cfhost/worker/src/index.ts#L14-L50)

当前行为为：

- `ALLOW_ANY_ORIGIN` 未显式设置为 `true` 时，空的 `ALLOWED_ORIGINS` 默认拒绝。
- Worker 自身 Origin 仍可用。
- `/ws`、访客认证、上传接口和 CORS 均使用 Origin 检查。
- Agent 状态变更接口增加同源 Origin 检查。

生产配置中的白名单也已明确设置。

注意：`ALLOW_ANY_ORIGIN=true` 是高风险开发配置，不应出现在生产环境。

---

## 7. 客户端 IP 信任问题

**状态：已修复**  
**当前风险：低**

相关位置：

- [Cloudflare 客户端地址处理](cfhost/worker/src/lib/util.ts#L20-L55)
- [WebSocket 和 HTTP 限流使用](cfhost/worker/src/index.ts#L66-L73)

当前仅信任 `cf-connecting-ip`，不再使用客户端可控的 `x-forwarded-for` 作为降级来源，并对 IPv4 映射地址和 IPv6 网段进行了统一处理。

该实现适用于通过 Cloudflare 代理访问的生产部署。若未来增加非 Cloudflare 直连入口，应重新审查该假设。

---

## 8. Cookie 密钥和签名

**状态：基本修复，仍有配置加固建议**  
**当前风险：低**

相关位置：

- [Cookie 密钥派生与签名](cfhost/worker/src/lib/cookies.ts#L1-L80)
- [Cookie 密钥选择](cfhost/worker/src/types.ts#L57-L63)

当前签名已包含：

- HMAC-SHA256。
- 用途标签派生密钥。
- Cookie 版本前缀。
- 过期时间。
- 恒定时间比较。

即使 `COOKIE_SECRET` 回退到 `JWT_SECRET`，Cookie 签名文本也不能直接充当 JWT。

但配置层面仍建议生产环境强制设置独立的 `COOKIE_SECRET`，避免 JWT 密钥泄露时扩大影响面，并便于独立轮换。

---

## 9. 消息和上传资源限制

**状态：已修复**  
**当前风险：低**

相关位置：

- [消息帧和文本限制](cfhost/worker/src/hub.ts#L20-L35)
- [发送消息限流](cfhost/worker/src/hub.ts#L760-L810)
- [上传限制](cfhost/worker/src/routes/upload.ts#L8-L77)

当前已具备：

- WebSocket 帧大小限制。
- 文本消息约 4000 字符限制。
- 访客按身份的发送消息限流。
- 上传文件 5 MB 限制。
- multipart 请求体前置限制。
- Agent/Visitor 和客户端地址多维度上传限流。
- 图片扩展名、MIME、魔数三重检查。

上一轮消息无限制导致存储膨胀的主要风险已明显降低，但仍建议监控单个访客和单个房间的累计消息量。

---

# 三、本轮新发现的问题

## CF-01：访客发送 Bucket 可能在大量持续活跃身份下增长

**等级：低到中**  
**类型：稳定性 / 内存占用**

相关位置：

- [访客消息 Bucket](cfhost/worker/src/hub.ts#L944-L964)

当前使用 `Map<string, Bucket>` 按 Visitor ID 保存限流桶。清理仅在创建新 Bucket 且当前数量超过 5000 时触发，并只删除超过 10 分钟未使用的条目。

### 风险

如果长期存在超过 5000 个持续活跃的 Visitor ID：

- 每个身份都会保留一个 Bucket。
- 清理条件虽然会执行，但持续活跃条目不会被清除。
- Map 的实际大小可能继续超过 5000。
- Durable Object 长期运行时会增加内存压力。

该问题需要大量不同 Visitor ID 才能触发，不属于直接认证漏洞。

### 建议

- 使用定期 Alarm 清理过期 Bucket。
- 设置硬上限并采用 LRU 或按时间淘汰。
- 视部署规模，将访客发送限流迁移到共享 Durable Object 限流器。
- 对 Visitor 数量、Bucket 数量和 Durable Object 内存进行监控。

---

## CF-02：Visitor Token 仍可通过 `?vt=` 查询参数传输

**等级：低**  
**类型：凭证暴露 / 防御深度

相关位置：

- [Visitor Token 来源](cfhost/worker/src/lib/auth.ts#L25-L31)
- [文件响应 Referrer-Policy](cfhost/worker/src/routes/files.ts#L39-L43)

系统支持通过以下方式传递 Visitor Token：

- `x-visitor-token` 请求头。
- `visitorAuth` Cookie。
- `?vt=` 查询参数。

查询参数可能进入：

- 浏览器历史记录。
- 代理或网关访问日志。
- 监控系统。
- 用户分享的 URL。
- 部分错误报告和调试工具。

文件响应已经设置 `Referrer-Policy: no-referrer`，可降低 Referer 泄露，但不能消除 URL 本身被记录的风险。

### 建议

- 仅保留 Header 和 Cookie 传递方式。
- 如果必须兼容 `?vt=`，将其限制为短期一次性 Token。
- 对查询参数 Token 设置更短有效期，并在使用后立即换成 Cookie。
- 前端和文档明确禁止把带 `vt` 的 URL 分享给他人。

---

## CF-03：翻译上游错误响应正文被写入日志

**等级：低**  
**类型：日志信息泄露

相关位置：

- [翻译错误日志](cfhost/worker/src/routes/translate.ts#L43-L46)

上游 Google Translation 请求失败时，代码会将 HTTP 状态码以及最多 500 个字符的上游响应正文写入 Worker 日志。

通常 Google 错误响应不会回显 API Key，因此实际泄露概率较低；但错误正文可能包含请求诊断信息、配额信息、项目标识或上游内部细节。

### 建议

生产日志只保留：

- 状态码。
- 内部请求追踪 ID。
- 非敏感的错误分类。

不要记录上游完整响应正文。

---

# 四、稳定性与运维建议

## 1. Session 空闲 TTL 为 60 天

相关位置：[Session TTL](cfhost/worker/src/hub.ts#L27-L31)

60 天滑动空闲窗口对客服系统偏宽。若 Agent 浏览器长期遗失且 Cookie/JWT 被复制，Session 在较长时间内仍可能有效。

建议根据业务选择 7 至 30 天，并配合：

- 主动注销。
- 密码修改时撤销其他 Session。
- 管理员查看和撤销 Session 的能力。
- 登录设备列表。

这是风险降低建议，不是当前确认的漏洞。

## 2. 访客限流和 Bark 推送应持续监控

访客消息会触发 Bark 通知，但当前已经加入按房间的通知间隔保护。建议监控：

- 单位时间消息数量。
- Bark 请求失败率。
- Durable Object CPU 时间。
- R2 写入量。
- SQLite 数据增长速度。

## 3. 数据库查询压力需要压测确认

现有 `messages(roomId, timestamp)` 索引已覆盖历史分页、最后消息和多数房间列表查询。随着房间和消息数量增加，建议通过生产规模数据压测：

- 房间列表查询。
- 未读数量计算。
- 历史记录分页。
- 知识库替换事务。
- 管理批量导入事务。

## 4. 运行时测试仍未完成

本轮为静态复审，未验证：

- 大量并发 WebSocket。
- Durable Object 休眠/唤醒后的限流状态。
- Cloudflare 真实边缘环境下的 Origin 和 IP 行为。
- R2 写入成功但元数据事务失败时的回滚效果。
- 大规模导入和长时间运行内存表现。
- 第三方 API 超时和错误响应行为。

---

# 五、当前有效的安全控制

以下控制在当前代码中已确认存在：

1. WebSocket Origin 校验和升级限流。
2. WebSocket 单帧大小限制。
3. WebSocket 事件分类限流。
4. Agent Session 实时复核和旧连接关闭。
5. REST Agent JWT + Session 双重校验。
6. Visitor 无凭证时生成随机身份。
7. CORS 和 Origin 默认拒绝。
8. Agent 状态变更接口同源校验。
9. 登录失败按 IP 和账号限流。
10. 管理接口失败限流。
11. 上传 Content-Length、文件大小、扩展名、MIME 和魔数检查。
12. 文件访问按上传元数据和房间权限控制。
13. 管理导入请求体、行数和字段大小限制。
14. 管理文件大小和图片内容限制。
15. SQL 参数化查询和 Durable Object 事务。
16. JWT 算法限定为 HS256。
17. Cookie HMAC、用途派生、过期和恒定时间比较。
18. 生产依赖审计未发现已知漏洞。

---

# 六、修复优先级

## 建议优先处理

1. 为访客限流 Bucket 增加定期清理和硬上限。
2. 移除或弱化 `?vt=` 查询参数 Token 传输方式。
3. 不记录翻译上游完整错误响应正文。
4. 生产环境强制设置独立的 `COOKIE_SECRET`。
5. 根据业务将 Agent Session 空闲 TTL 从 60 天调整到更短周期。

## 建议持续验证

6. 对 WebSocket 连接风暴和消息洪泛进行压力测试。
7. 对 Durable Object 长时间运行内存进行监控。
8. 对 SQLite 房间列表、未读统计和历史分页进行大数据量压测。
9. 对管理接口进行真实 Content-Length、分块请求和异常请求测试。
10. 确认生产环境没有设置 `ALLOW_ANY_ORIGIN=true`。

---

# 七、最终评级

| 范围 | 复审评级 |
|---|---|
| Origin/CORS/CSRF | 良好 |
| WebSocket 认证和撤销 | 良好 |
| WebSocket 限流 | 良好，需继续压测 |
| REST Agent 授权 | 良好 |
| Visitor 身份保护 | 良好，查询参数 Token 需优化 |
| 文件上传与访问 | 良好 |
| 管理接口 | 良好，建议增加网络层隔离 |
| 数据库并发 | 良好，需大数据量压测 |
| 长期运行稳定性 | 良好，需关注内存 Map |
| 依赖风险 | 当前未发现已知漏洞 |

**综合结论：** 上一轮提出的核心安全问题已基本完成修复，本轮未发现新的高危或严重漏洞。当前主要剩余项属于低风险凭证传输、日志规范和长期运行内存管理问题。CFHost 可以继续运行，但正式生产环境仍应完成压力测试、运行监控和管理接口网络隔离。

**是否修改代码：** 否，仅生成本报告。
