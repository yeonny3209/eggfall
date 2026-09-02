import { defineConfig } from 'vite';

// GitHub Pages 프로젝트 사이트는 /<repo>/ 경로에서 서빙된다.
// 로컬 개발(base '/')은 건드리지 않고 CI 빌드에서만 GITHUB_PAGES_BASE 로 넘긴다.
const base = process.env.GITHUB_PAGES_BASE || '/';

export default defineConfig({
  base,
  server: { port: 5273, strictPort: true },
  build: { target: 'es2022', outDir: 'dist' },
});
