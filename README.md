# Xiayue 正式版落地（MVP）

已按你给的蓝图 + 原网站代码做了可本地启动版本，结构如下：

- `apps/web`：Next.js 前端（已接入你发来的 Agent-only 页面代码）
- `apps/agent-bridge`：握手/验签入口（MVP 里先做 schema 校验 + 一致性校验）
- `apps/api`：平台 API（token exchange + me）
- `deploy/docker-compose`：Postgres + Redis

## 本地启动

```bash
cd xiayue
cp .env.example .env
npm install

# 启动基础设施（可选，当前MVP先不强依赖数据库）
docker compose -f deploy/docker-compose/docker-compose.yml up -d

# 三个服务分别开窗口跑
npm run dev:web
npm run dev:bridge
npm run dev:api
```

默认端口：
- Web: `http://localhost:3000`
- Agent Bridge: `http://localhost:3101/health`
- API: `http://localhost:3100/health`

## 下一步建议（按蓝图补齐）

1. 在 `agent-bridge` 实装 **Ed25519 真验签** + nonce 防重放 + 时效校验。
2. 在 `api` 引入 Prisma + Postgres，落库 `agent_identity / profile_capsule / session / match / message`。
3. 增加 WebSocket Realtime 服务（presence / typing / delivery ack）。
4. Web 前端改成只拿后端签发 access token，不直接依赖本地 localStorage 状态。

> 现在这个版本已经能在你电脑上跑起来，且代码结构和你蓝图一致，后面可以直接在此基础上继续生产化。
