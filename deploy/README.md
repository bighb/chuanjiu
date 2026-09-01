# 一次性部署准备

这些步骤只做一次（换机器 / 服务器重装时再做一次）。做完之后就是「推 `main` 即自动部署」，日常使用见仓库根 `README.md`。

架构总览、决策理由见规划仓库 `bbq-research/docs/02-架构设计.md`；本文档只给可执行步骤。

> ⚠️ **顺序不要打乱。** `.github/workflows/deploy.yml` 一旦随代码推上去，往 `main` 推代码就会立刻触发 CI——服务器和 GitHub secrets 必须在第一次推代码之前就准备好，nginx 反代也要在第一次成功部署之前配好，否则工作流最后的 `Verify` 步骤会因为拿不到 200 而报红。

## 1. 生成部署专用 SSH 密钥

不要复用自己的私钥，单独生成一把，方便将来撤销：

```bash
ssh-keygen -t ed25519 -C "github-actions-chuanjiu" -f ./chuanjiu_deploy_key -N ""

# 公钥装到服务器 deploy 用户下
ssh <服务器别名> "mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && \
  cat >> /home/deploy/.ssh/authorized_keys && \
  chown -R deploy:deploy /home/deploy/.ssh && \
  chmod 600 /home/deploy/.ssh/authorized_keys" < ./chuanjiu_deploy_key.pub

# 验证新钥匙能登录、能跑 docker
ssh -i ./chuanjiu_deploy_key -o IdentitiesOnly=yes deploy@<服务器IP> 'docker ps'
```

## 2. 服务器建 compose 目录

```bash
ssh <服务器别名> 'mkdir -p /home/deploy/chuanjiu && chown deploy:deploy /home/deploy/chuanjiu'
scp deploy/docker-compose.yml <服务器别名>:/home/deploy/chuanjiu/
```

`deploy/docker-compose.yml` 是仓库里存的真相源——**它不会被 CI 自动同步到服务器**，改了这份文件（比如调健康检查、端口）之后要手动 `scp` 一次并在服务器上 `docker compose up -d` 让改动生效。

## 3. 配置宿主 nginx 反代

在服务器门户站 vhost（通常是 `/etc/nginx/sites-available/portal`）的 **443 server 块**里、`location /` **之前**插入 `deploy/portal-nginx-snippet.conf` 的内容，然后：

```bash
ssh <服务器别名> 'nginx -t && systemctl reload nginx'
```

`nginx -t` 不通过就不要 reload。此时访问 `/bbq/` 会返回 **502，这是正常的**——容器还没起。

## 4. 建 GitHub 仓库并配 Secrets（在推代码之前）

```bash
gh repo create bighb/chuanjiu --public --description "串究 · 武汉/安陆烧烤研究站"

gh secret set SSH_HOST --repo bighb/chuanjiu --body "<服务器IP>"
gh secret set SSH_USER --repo bighb/chuanjiu --body "deploy"
gh secret set SSH_KEY  --repo bighb/chuanjiu < ./chuanjiu_deploy_key
```

配完把本地私钥文件删掉。

## 5. 推首版代码

```bash
git remote add origin git@github.com:bighb/chuanjiu.git
git push -u origin main
```

## 6. 检查 GHCR 镜像包可见性

服务器上的 `docker compose pull` 没有配任何 registry 凭据，镜像包必须是 **Public** 才能拉取成功。GitHub 个人主页 → Packages → chuanjiu → Package settings → Danger Zone 里能看到当前可见性。

> **实测记录**：2026-09 用 `bighb` 账号首次部署时，镜像包**自动就是 Public 的**，第一次 CI 没有在部署步骤失败过——这跟旧版文档「新推的包默认私有，第一次 CI 必然失败一次」的说法不一致，大概率是 GitHub 后来调整了「public 仓库关联的容器包默认继承仓库可见性」的策略。**但不要假设未来/别的账号也一定如此**——推完代码后照上面那条查一眼，是 Private 就去 Package settings 改成 Public，重新触发一次工作流（Actions 页面点 `Run workflow`）。

## 7. 门户站加导航入口

编辑 `personal-portal/web/src/consts.ts`，在 `SECTIONS` 数组里 `notes` 之后、`tools` 之前插入：

```ts
{ slug: 'bbq', label: '烧烤研究', href: '/bbq/', icon: '🍢', desc: '武汉 · 安陆烧烤全流程拆解' },
```

然后按门户站自己的部署流程构建并上线一次（`pnpm --dir web build && rsync -az --delete web/dist/ <门户站部署别名>:/var/www/portal/`，具体以门户站仓库当时的实际流程为准——`personal-portal/deploy/README.md` 那份可能已经过期，不要照抄细节，路径核心逻辑通常没变）。这是唯一一次因为这个项目而需要重新部署门户站。

## 8. 首次验收

```bash
# 容器起来了
ssh <服务器别名> 'docker ps --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"'

# 容器自身可达
ssh <服务器别名> 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8010/bbq/'

# 公网可达
curl -s -o /dev/null -w "%{http_code}\n" https://benrush.cn/bbq/
curl -s -L -o /dev/null -w "%{http_code}\n" https://benrush.cn/bbq/ingredients

# 裸 /bbq 应当 301 到 /bbq/
curl -s -D - -o /dev/null https://benrush.cn/bbq | grep -i location
```

再用浏览器实际打开一次，确认**样式和图片都加载出来了**——只看状态码验不出资源路径错，而资源路径正是子路径部署最常翻车的地方。

## 排错对照表

| 现象 | 大概率原因 |
|---|---|
| CI 在 build 阶段失败 | 内容 schema 校验没过（预期行为，说明内容写错了）。看日志里 Astro 报的文件名和字段 |
| CI 在 deploy 阶段 `denied` / `unauthorized` | GHCR 镜像包还是私有的，见第 6 步 |
| CI 在 deploy 阶段 SSH 连不上 | secret 里的私钥格式不对、公钥没装到 `deploy` 用户下、或服务器防火墙拦了 |
| 部署成功但页面 404 | 宿主 nginx 那段 location 没加，或 `nginx -t` 通过了但没 reload |
| 页面能开但样式全丢、图片全裂 | `proxy_pass` 末尾多写了斜杠（剥掉了 `/bbq` 前缀），或 `astro.config.mjs` 里 `base` 没设/写错 |
| `docker ps` 显示 `unhealthy` 但站点访问正常 | 容器 `/etc/hosts` 里 `localhost` 优先解析成 IPv6 `::1`，但 nginx 只监听纯 IPv4——healthcheck 探测脚本要用 `127.0.0.1` 不要用 `localhost`（`deploy/docker-compose.yml` 已经这么写了，别改回 `localhost`） |
| 站内点链接 404，但直接输地址能开 | `<a href>` 没走 `src/lib/url.ts` 的 `url()` 工具做 base 拼接 |
| 改了内容推了 main，但页面没变 | 浏览器缓存（强刷试试）；或 CI 因 `paths-ignore` 没触发（只改了 `docs/` 或根 `README.md`）；或服务器 `.env` 还钉着旧 TAG |
