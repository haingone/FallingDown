import { defineConfig, type Plugin } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** AD 산출 스프라이트 반입 경로 (저장소 루트 art/sprites) — 개발 세션은 읽기만 한다 */
const SPRITE_DIR = path.resolve(here, '../art/sprites');
const SERVED_EXT = new Set(['.png', '.json']);

function listSprites(): string[] {
  if (!fs.existsSync(SPRITE_DIR)) return [];
  return fs.readdirSync(SPRITE_DIR).filter((f) => SERVED_EXT.has(path.extname(f).toLowerCase()));
}

/**
 * art/sprites/ 를 `/sprites/` 로 서빙·번들한다.
 * vite root(game/) 바깥이라 publicDir로는 잡히지 않으므로 전용 플러그인을 둔다.
 * 디렉터리가 비어 있어도 정상 동작한다 (로더가 실루엣 플레이스홀더를 유지).
 */
function spriteAssets(): Plugin {
  return {
    name: 'fd-sprite-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/sprites\/([^/?#]+)/.exec(req.url ?? '');
        if (!m) return next();
        const file = path.join(SPRITE_DIR, m[1]);
        if (!file.startsWith(SPRITE_DIR) || !fs.existsSync(file)) {
          res.statusCode = 404;
          res.end('sprite asset not found');
          return;
        }
        res.setHeader('Content-Type', path.extname(file) === '.json' ? 'application/json' : 'image/png');
        res.end(fs.readFileSync(file));
      });
    },
    generateBundle() {
      for (const f of listSprites()) {
        this.emitFile({
          type: 'asset',
          fileName: `sprites/${f}`,
          source: fs.readFileSync(path.join(SPRITE_DIR, f)),
        });
      }
    },
  };
}

// base './' : 정적 호스팅 어느 경로에 올려도 동작 (앱인토스 WebView 배포 대비, SDK 연동은 범위 외)
export default defineConfig({
  base: './',
  plugins: [spriteAssets()],
  server: { host: true },
  build: { target: 'es2022', sourcemap: false },
});
