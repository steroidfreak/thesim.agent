import 'dotenv/config';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createApp } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3001);

async function startDevServer() {
  const app = createApp();
  const server = http.createServer(app);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Stop the existing server or change PORT in .env.`);
      process.exit(1);
    }

    throw error;
  });
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: {
        server,
      },
    },
    appType: 'custom',
  });

  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || req.url?.startsWith('/api/')) {
      return next();
    }

    try {
      const url = req.originalUrl || req.url || '/';
      const templatePath = path.join(rootDir, 'index.html');
      const template = await fs.readFile(templatePath, 'utf8');
      const html = await vite.transformIndexHtml(url, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
    } catch (error) {
      vite.ssrFixStacktrace(error);
      next(error);
    }
  });

  server.listen(port, () => {
    console.log(`AI world dev server listening on http://localhost:${port}`);
  });
}

startDevServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
