/**
 * RateLimiter Durable Object — per-API-key rate limiting with fixed window counters.
 *
 * Live keys: 30/min, 200/hr
 * Test keys: 10/min, 50/hr
 *
 * Storage keys use time-bucketed prefixes so old entries naturally become irrelevant.
 */

import { DurableObject } from 'cloudflare:workers';

interface RateLimitConfig {
  minuteLimit: number;
  hourLimit: number;
}

const LIVE_CONFIG: RateLimitConfig = { minuteLimit: 30, hourLimit: 200 };
const TEST_CONFIG: RateLimitConfig = { minuteLimit: 10, hourLimit: 50 };

interface CheckRequest {
  action: 'check';
  keyHash: string;
  keyType: 'live' | 'test';
}

export class RateLimiter extends DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as CheckRequest;

    if (body.action === 'check') {
      const config = body.keyType === 'live' ? LIVE_CONFIG : TEST_CONFIG;
      const result = await this.checkLimit(body.keyHash, config);

      // Ensure cleanup alarm is scheduled
      const existingAlarm = await this.state.storage.getAlarm();
      if (!existingAlarm) {
        await this.state.storage.setAlarm(Date.now() + 60 * 60 * 1000); // 1 hour
      }

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async checkLimit(
    keyHash: string,
    config: RateLimitConfig
  ): Promise<{ allowed: boolean; remaining: number; reset_at: number }> {
    const now = Math.floor(Date.now() / 1000);
    const minuteBucket = Math.floor(now / 60);
    const hourBucket = Math.floor(now / 3600);

    const minuteKey = `rl:${keyHash}:m:${minuteBucket}`;
    const hourKey = `rl:${keyHash}:h:${hourBucket}`;

    const storage = this.state.storage;
    const currentMinute = (await storage.get<number>(minuteKey)) ?? 0;
    const currentHour = (await storage.get<number>(hourKey)) ?? 0;

    const minuteRemaining = config.minuteLimit - currentMinute;
    const hourRemaining = config.hourLimit - currentHour;

    const allowed = minuteRemaining > 0 && hourRemaining > 0;

    if (allowed) {
      await storage.put({
        [minuteKey]: currentMinute + 1,
        [hourKey]: currentHour + 1,
      });
    }

    // Reset at the larger of the minute and hour reset times
    const minuteReset = (minuteBucket + 1) * 60;
    const hourReset = (hourBucket + 1) * 3600;
    const resetAt = Math.max(minuteReset, hourReset);

    return {
      allowed,
      remaining: allowed
        ? Math.max(0, Math.min(minuteRemaining - 1, hourRemaining - 1))
        : 0,
      reset_at: resetAt,
    };
  }

  async alarm(): Promise<void> {
    // Cleanup old rate limit keys periodically
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = Math.floor(now / 60);
    const currentHour = Math.floor(now / 3600);

    const all = await this.state.storage.list({ prefix: 'rl:' });
    const toDelete: string[] = [];

    for (const [key] of all) {
      const parts = key.split(':');
      // rl:{keyHash}:{m|h}:{bucket}
      if (parts.length !== 4) continue;

      const bucketType = parts[2];
      const bucket = parseInt(parts[3], 10);

      if (bucketType === 'm' && bucket < currentMinute - 5) {
        toDelete.push(key);
      } else if (bucketType === 'h' && bucket < currentHour - 2) {
        toDelete.push(key);
      }
    }

    if (toDelete.length > 0) {
      await this.state.storage.delete(toDelete);
    }
  }
}
