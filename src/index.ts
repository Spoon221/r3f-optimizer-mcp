#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function startHttp(port: number, host: string) {
  // Stateless mode: every request gets its own server instance.
  const http = createHttpServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' }).end(req.url === '/health' ? 'ok' : 'not found');
      return;
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  });
  http.listen(port, host, () => {
    console.error(`r3f-optimizer-mcp listening on http://${host}:${port}/mcp`);
  });
}

async function main() {
  if (args.includes('--http')) {
    await startHttp(Number(option('--port') ?? process.env.PORT ?? 3333), option('--host') ?? '127.0.0.1');
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
