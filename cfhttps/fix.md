1. 同站客服凭据（C5）
*.efxopen.com 与 csa.efxopen.com 属于同站，客服 SameSite=Lax Cookie 会随请求发送。若允许的子域发生 XSS 或被接管，可能借 Cookie 冒用客服身份访问 HTTP 接口或 WebSocket。

修复原则：仅在请求没有 Origin 或 Origin 为本站时接受客服 Cookie。

resolveAgent、authenticateAgent 和 /api/verify-token 拒绝其他来源的客服凭据。
WebSocket 升级时，其他来源不得记录客服 Cookie。
回归测试：带 Origin: https://x.efxopen.com 和客服 Cookie 的历史、上传及 agent-login 应被拒绝；本站来源仍可用。
已修复：限制客服 Cookie 的读取及 WebSocket 附件；跨来源显式令牌和访客凭据仍按原规则验证。独立的来源检查和限流仍然生效。
2. Trusted Types（B1）
为兼容启用 require-trusted-types-for 'script' 的宿主，处理 emloader.js、embed.js 中的脚本 URL 与 HTML sink：

由 emloader.js 单次创建名为 efx-chat 的 policy，并只读传给 embed.js；createScriptURL 仅允许 https://chatembed.efxopen.com。
createHTML 只接受两段固定模板；动态文案用 textContent 设置。其余 sink 改用文本节点、textContent 或 replaceChildren()；链接仅允许 http(s)。
不支持 Trusted Types 或 policy 创建失败时保留兼容降级；强制策略的宿主须允许 efx-chat。
发布时同步提升 emloader.js 的 DEFAULT_VERSION 与 Worker 的 APP_VERSION。
已修复：当前源码版本均为 83，部署脚本每次按本地和线上版本最大值加一；新增 Chromium 回归测试。若宿主强制 Trusted Types 且禁止创建该 policy，组件无法加载；不强制时可降级。
3. 访客令牌 URL（B2）
旧组件图片 URL 可能包含 ?vt=，令牌也可能进入代理和平台日志。Worker 不使用任何路径的 URL 令牌进行授权，包括图片、历史和上传；图片读取支持 x-visitor-token、签名访客 Cookie 或有效客服会话。带查询参数的请求仍可由独立有效的请求头或 Cookie 授权，URL 令牌本身不起作用。

新组件通过请求头加载图片。若生产 Worker 先部署，依赖 URL 令牌且无其他有效凭据的旧组件图片将暂时失效，直到组件刷新并升级；此过程不兼容，也不保证自动刷新成功。旧组件仍可能发送含令牌的 URL，应限制相关日志访问和保留期限。


4. 图片读取授权与滥用防护
已在本地修复：上传元数据与房间绑定；每次读取均检查元数据、访客房间归属或有效客服会话，未登记的对象不可读取。客服现有权限模型允许有效客服查看所有房间。响应禁止缓存并设置 nosniff、no-referrer 和沙箱 CSP。

跨站组件使用带 x-visitor-token 的 CORS 请求获取图片并以 Blob URL 展示，避免长期访客令牌出现在图片 URL；不采用短期签名 URL，以免签名凭据仍进入 URL 日志。只允许本站上传路径，请求失败可点击重试，历史重置释放 Blob。宿主 CSP 必须允许 API 域名的 connect-src 和 img-src blob:；第三方浏览器扩展、宿主脚本或请求头日志仍可能读取凭据。

读取限制为每 IP 每分钟 600 次；上传保留身份/IP 限流，新增每 IP 15 分钟 150 次尝试和每天 200 次尝试，以及请求体实际字节上限。限流器故障时图片读取和上传拒绝请求。现有格式魔数检查仅识别文件头，不是完整图片解码或恶意内容扫描；IP 限额并非全局存储上限，分布式攻击仍需 Cloudflare/WAF、R2 用量告警及清理策略。

本地通过跨站/跨房间授权、未登记对象、条件请求、上传/读取限流、Chromium 组件和完整聊天冒烟测试。资源本身仍可被授权用户保存或转发，不能防止有权用户复制图片。