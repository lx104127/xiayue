import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

const server = Fastify({ logger: true });
await server.register(cors, { origin: true, credentials: true });

const MAX_SKEW_MS = 30_000;
const MAX_TTL_MS = 5 * 60_000;

// SPKI prefix for raw Ed25519 32-byte pubkey (RFC8410)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const usedNonceStore = new Map<string, number>();

const passportSchema = z.object({
  source: z.literal('openclaw'),
  entityType: z.literal('agent'),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().min(8).max(128),
  agentPublicKey: z.string().min(20),
  signature: z.string().min(16)
});

const capsuleSchema = z.object({
  source: z.literal('openclaw'),
  entityType: z.literal('agent_profile_capsule'),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()).min(1),
  signedAt: z.string().datetime(),
  signature: z.string().min(16)
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

function stripSignature<T extends { signature: string }>(obj: T) {
  const { signature: _sig, ...rest } = obj;
  return rest;
}

function parseSignature(sig: string): Buffer {
  const s = sig.trim();
  const base64url = /^[A-Za-z0-9_-]+$/;
  const hex = /^[0-9a-fA-F]+$/;

  if (s.includes('+') || s.includes('/') || s.includes('=')) return Buffer.from(s, 'base64');
  if (hex.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
  if (base64url.test(s)) {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64');
  }
  throw new Error('Unsupported signature encoding');
}

function buildEd25519PublicKey(key: string) {
  const k = key.trim();
  if (k.includes('BEGIN PUBLIC KEY')) return createPublicKey(k);

  const raw = (() => {
    const base64url = /^[A-Za-z0-9_-]+$/;
    const hex = /^[0-9a-fA-F]+$/;
    if (hex.test(k) && k.length === 64) return Buffer.from(k, 'hex');
    if (base64url.test(k)) {
      const padded = k.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(k.length / 4) * 4, '=');
      return Buffer.from(padded, 'base64');
    }
    return Buffer.from(k, 'base64');
  })();

  if (raw.length !== 32) throw new Error('agentPublicKey must be Ed25519 raw 32-byte key or PEM');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function verifySignedObject(obj: { signature: string }, publicKey: string) {
  const payload = Buffer.from(JSON.stringify(canonicalize(stripSignature(obj))), 'utf8');
  const sig = parseSignature(obj.signature);
  const key = buildEd25519PublicKey(publicKey);
  return verify(null, payload, key, sig);
}

function assertPassportTimeValid(issuedAt: string, expiresAt: string) {
  const now = Date.now();
  const iat = new Date(issuedAt).getTime();
  const exp = new Date(expiresAt).getTime();

  if (!Number.isFinite(iat) || !Number.isFinite(exp)) throw new Error('Invalid issuedAt/expiresAt');
  if (exp <= iat) throw new Error('expiresAt must be after issuedAt');
  if (exp - iat > MAX_TTL_MS) throw new Error('Passport TTL too long');
  if (iat - now > MAX_SKEW_MS) throw new Error('Passport issuedAt is in the future');
  if (now > exp + MAX_SKEW_MS) throw new Error('Passport expired');
}

function assertCapsuleFresh(signedAt: string) {
  const now = Date.now();
  const sat = new Date(signedAt).getTime();
  if (!Number.isFinite(sat)) throw new Error('Invalid capsule signedAt');
  if (sat - now > MAX_SKEW_MS) throw new Error('Capsule signedAt is in the future');
  if (now - sat > MAX_TTL_MS) throw new Error('Capsule signature is too old');
}

function consumeNonce(agentId: string, nonce: string, expiresAt: string) {
  const now = Date.now();

  for (const [key, exp] of usedNonceStore.entries()) {
    if (exp <= now) usedNonceStore.delete(key);
  }

  const cacheKey = `${agentId}:${nonce}`;
  if (usedNonceStore.has(cacheKey)) throw new Error('Replay detected: nonce already used');

  const nonceExpireAt = new Date(expiresAt).getTime() + MAX_SKEW_MS;
  usedNonceStore.set(cacheKey, nonceExpireAt);
}

server.get('/health', async () => ({ ok: true, service: 'agent-bridge' }));

server.post('/v1/handshake', async (req, reply) => {
  try {
    const body = z.object({ passport: passportSchema, capsule: capsuleSchema }).parse(req.body);

    if (body.passport.sessionId !== body.capsule.sessionId || body.passport.agentId !== body.capsule.agentId) {
      return reply.code(400).send({ ok: false, reason: 'Passport and capsule mismatch' });
    }

    assertPassportTimeValid(body.passport.issuedAt, body.passport.expiresAt);
    assertCapsuleFresh(body.capsule.signedAt);

    if (!verifySignedObject(body.passport, body.passport.agentPublicKey)) {
      return reply.code(401).send({ ok: false, reason: 'Invalid passport signature' });
    }

    if (!verifySignedObject(body.capsule, body.passport.agentPublicKey)) {
      return reply.code(401).send({ ok: false, reason: 'Invalid capsule signature' });
    }

    consumeNonce(body.passport.agentId, body.passport.nonce, body.passport.expiresAt);

    return {
      ok: true,
      agentIdentity: {
        agentId: body.passport.agentId,
        agentName: body.passport.agentName,
        sessionId: body.passport.sessionId
      }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'handshake failed';
    return reply.code(400).send({ ok: false, reason: message });
  }
});

const port = Number(process.env.PORT || 3101);
server.listen({ port, host: '0.0.0.0' });
