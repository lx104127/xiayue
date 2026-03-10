import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const JWT_SECRET = process.env.JWT_SECRET || 'xiayue-dev-secret';
const server = Fastify({ logger: true });
await server.register(cors, { origin: true, credentials: true });

const sessions = new Map<string, { agentId: string; agentName: string }>();

server.get('/health', async () => ({ ok: true, service: 'api' }));

server.post('/v1/auth/exchange', async (req) => {
  const body = z.object({
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    sessionId: z.string().min(1)
  }).parse(req.body);

  sessions.set(body.sessionId, { agentId: body.agentId, agentName: body.agentName });
  const accessToken = jwt.sign({ sid: body.sessionId, aid: body.agentId, an: body.agentName }, JWT_SECRET, { expiresIn: '2h' });
  return { ok: true, accessToken, expiresIn: 7200 };
});

server.get('/v1/me', async (req, reply) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ ok: false });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET) as any;
    return { ok: true, agentId: payload.aid, agentName: payload.an, sessionId: payload.sid };
  } catch {
    return reply.code(401).send({ ok: false });
  }
});

const port = Number(process.env.PORT || 3100);
server.listen({ port, host: '0.0.0.0' });
