# 串究 · 武汉/安陆烧烤研究站

系统研究武汉、安陆一带烧烤的内容站，把每种食材从「取材 → 穿串 → 腌制 → 给料 → 火候」的全流程拆开讲清楚。

公网地址：<https://benrush.cn/bbq/>

## 日常使用

### 加一种新食材

1. 在 `src/data/bbq/` 下新建一个 `<slug>.md`（`<slug>` 用小写英文短横线，就是 URL 的最后一段），照着已有文件（比如 `wuhua-rou.md`）抄结构。字段说明见规划仓库 `bbq-research/docs/03-数据模型.md` §3。
2. 本地预览确认没问题：

   ```bash
   pnpm dev   # → http://localhost:4321/bbq/
   ```

3. 确认没问题就推：

   ```bash
   git add -A && git commit -m "新增：烤茄子"
   git push
   ```

   剩下的全自动：GitHub Actions 构建镜像 → 推 GHCR → SSH 到服务器拉起容器，约 2–3 分钟后 <https://benrush.cn/bbq/> 就更新了。

### 补照片

图片放 `src/assets/bbq/<slug>/`，在对应食材的 `.md` 里填 `photo`（相对路径，如 `../../assets/bbq/wuhua-rou/done.jpg`）和 `photoAlt`（替代文字），推送即可，构建期会自动压缩、转 webp、生成宽高属性。

**提交前务必先把手机原图缩到长边 2000px 以内**——原图动辄 3–5MB，一旦进了 git 历史就永远留在仓库里，删不干净。

### 内容写完先自查

写完/改完任何一个食材文件，对照 `bbq-research/docs/03-数据模型.md` §6 的「内容自检清单」过一遍——`fire.stages` 时长加总要等于 `specs` 里的烤制时间、同一个东西全站叫法要一致，这些 schema 校验拦不住，得靠人眼查。

首批内容全部是案头整理，没有实地验证过，所以都标着 `status: draft`，页面上会显示「待验证」徽标。实地烤过验证之后，把对应文件的 `status` 改成 `verified` 即可。

### 回滚

镜像每次都打了 `sha-<commit>` 标签：

```bash
ssh deploy@8.155.148.6   # 或本机配好的别名
cd /home/deploy/chuanjiu
echo "TAG=sha-<要回滚到的完整 commit sha>" > .env
docker compose pull && docker compose up -d
```

确认恢复正常、问题也在 GitHub 上修好之后，**记得删掉 `.env`**（`rm .env`）再推下一次更新，否则会一直钉在旧版本上——这是最容易忘的一步。历史镜像标签在 GitHub 个人主页 → Packages → chuanjiu 里查。

## 和门户站的关系

- 视觉 token（颜色、主题切换机制）是从门户站 `personal-portal` **复制**过来的，不是引用共享。门户站以后改主题配色，这边**不会**自动跟着变，需要的话手动同步 `src/layouts/BaseLayout.astro` 里的 `:root` 变量。
- 亮暗主题选择是共享的：因为两个站同源（都是 `benrush.cn`），用的是同一个 `localStorage` 的 `theme` 键，在门户站切到暗色，进 `/bbq/` 也会是暗色，反之亦然。
- 这个仓库自己独立部署、独立构建，跟门户站的构建流程完全不相关，改这里的内容不需要也不应该去重新构建门户站。

## 技术栈与架构

Astro 6（Content Collections）+ 原生 JS，零前端框架、零外部字体/CDN。Docker 多阶段构建，产物由 nginx:alpine 托管，通过子路径 `/bbq/` 挂在门户站域名下。完整架构决策、CI/CD 配置、一次性部署步骤见 `deploy/README.md` 和规划仓库 `bbq-research/docs/`（02、06 两份文档）。
