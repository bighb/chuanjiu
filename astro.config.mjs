// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://benrush.cn',
  base: '/bbq', // ← 子路径部署的关键，见 02 文档 D-9
  build: {
    format: 'directory', // 每页输出 <路由>/index.html，配合 nginx try_files 最省事
  },
});
