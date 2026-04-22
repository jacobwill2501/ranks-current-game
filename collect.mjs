import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import 'dotenv/config';

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  console.error('RIOT_API_KEY not set — copy .env.example to .env and fill it in');
  process.exit(1);
}

// Token bucket rate limiter matching Riot dev key limits: 20/s, 100/2min
class RateLimiter {
  constructor() {
    this.buckets = [
      { limit: 20, windowMs: 1_000, tokens: 20, lastRefill: Date.now() },
      { limit: 100, windowMs: 120_000, tokens: 100, lastRefill: Date.now() },
    ];
    this.queue = [];
    this.processing = false;
    this.retryAfterExpires = 0;
  }

  refill() {
    const now = Date.now();
    for (const b of this.buckets) {
      if (now - b.lastRefill >= b.windowMs) {
        b.tokens = b.limit;
        b.lastRefill = now;
      }
    }
  }

  canAcquire() {
    if (Date.now() < this.retryAfterExpires) return false;
    this.refill();
    return this.buckets.every(b => b.tokens > 0);
  }

  acquire() {
    for (const b of this.buckets) b.tokens--;
  }

  waitTime() {
    const now = Date.now();
    if (now < this.retryAfterExpires) return this.retryAfterExpires - now;
    let min = Infinity;
    for (const b of this.buckets) {
      if (b.tokens <= 0) min = Math.min(min, Math.max(b.windowMs - (now - b.lastRefill), 50));
    }
    return min === Infinity ? 50 : min;
  }

  async waitForToken() {
    return new Promise(resolve => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  async drain() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      if (this.canAcquire()) {
        this.acquire();
        this.queue.shift()();
      } else {
        await sleep(this.waitTime());
      }
    }
    this.processing = false;
  }

  onHeaders(headers) {
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      this.retryAfterExpires = Date.now() + parseInt(retryAfter, 10) * 1000;
      console.log(`[rate] retry-after ${retryAfter}s`);
    }
    const count = headers.get('x-app-rate-limit-count');
    if (count) {
      count.split(',').forEach((part, i) => {
        if (i < this.buckets.length) {
          const used = parseInt(part.split(':')[0], 10);
          this.buckets[i].tokens = Math.max(0, this.buckets[i].limit - used);
        }
      });
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const limiter = new RateLimiter();
const NA = 'https://na1.api.riotgames.com';
const AMERICAS = 'https://americas.api.riotgames.com';

async function riotFetch(url) {
  await limiter.waitForToken();
  const res = await fetch(url, { headers: { 'X-Riot-Token': API_KEY } });
  limiter.onHeaders(res.headers);
  if (res.status === 429) {
    console.log('[rate] 429 — waiting before retry');
    await sleep(limiter.waitTime());
    return riotFetch(url);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Riot API ${res.status} ${url}: ${body}`);
  }
  return res.json();
}

async function fetchLeague(tier) {
  const path = {
    CHALLENGER: '/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5',
    GRANDMASTER: '/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5',
    MASTER: '/lol/league/v4/masterleagues/by-queue/RANKED_SOLO_5x5',
  }[tier];
  const data = await riotFetch(`${NA}${path}`);
  return data.entries.map(e => ({ summonerId: e.summonerId, lp: e.leaguePoints, tier }));
}

async function getSummonerPuuid(summonerId) {
  const data = await riotFetch(`${NA}/lol/summoner/v4/summoners/${encodeURIComponent(summonerId)}`);
  return data.puuid;
}

async function getAccountByPuuid(puuid) {
  const data = await riotFetch(`${AMERICAS}/riot/account/v1/accounts/by-puuid/${puuid}`);
  return { name: data.gameName, tag: data.tagLine };
}

const PROGRESS_FILE = 'progress.json';
const OUTPUT_FILE = 'players.json';

async function main() {
  let progress = { done: {}, players: [] };
  if (existsSync(PROGRESS_FILE)) {
    console.log('Resuming from progress.json...');
    progress = JSON.parse(await readFile(PROGRESS_FILE, 'utf8'));
  }

  const done = new Set(Object.keys(progress.done));
  const players = [...progress.players];

  console.log('Fetching league rosters...');
  const [challenger, grandmaster, master] = await Promise.all([
    fetchLeague('CHALLENGER'),
    fetchLeague('GRANDMASTER'),
    fetchLeague('MASTER'),
  ]);

  const all = [...challenger, ...grandmaster, ...master];
  const todo = all.filter(e => !done.has(e.summonerId));
  console.log(`Total: ${all.length} | Already done: ${done.size} | Remaining: ${todo.length}`);

  if (todo.length === 0) {
    console.log('Nothing to do — writing players.json');
    await writeFile(OUTPUT_FILE, JSON.stringify(players, null, 2));
    return;
  }

  const startTime = Date.now();

  for (let i = 0; i < todo.length; i++) {
    const entry = todo[i];
    try {
      const puuid = await getSummonerPuuid(entry.summonerId);
      const { name, tag } = await getAccountByPuuid(puuid);
      players.push({ name, tag, tier: entry.tier, lp: entry.lp });
      done.add(entry.summonerId);
    } catch (err) {
      console.error(`  error for ${entry.summonerId}: ${err.message}`);
    }

    if ((i + 1) % 100 === 0 || i === todo.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const rate = ((i + 1) / elapsed).toFixed(0);
      console.log(`  ${i + 1}/${todo.length} | ${players.length} players | ${elapsed}m elapsed | ~${rate}/min`);

      const doneObj = Object.fromEntries([...done].map(id => [id, true]));
      await writeFile(PROGRESS_FILE, JSON.stringify({ done: doneObj, players }, null, 2));
    }
  }

  await writeFile(OUTPUT_FILE, JSON.stringify(players, null, 2));
  console.log(`Done! Wrote ${players.length} players to ${OUTPUT_FILE}`);
  console.log('Commit players.json before Wednesday April 29.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
