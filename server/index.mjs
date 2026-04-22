import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  console.error('RIOT_API_KEY not set');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

app.use(cors({
  origin: isProduction ? 'https://jacobwill2501.github.io' : true,
}));

app.use(express.json());

const NA = 'https://na1.api.riotgames.com';
const AMERICAS = 'https://americas.api.riotgames.com';

async function riotFetch(url) {
  const res = await fetch(url, { headers: { 'X-Riot-Token': API_KEY } });
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('retry-after') || '1', 10) * 1000;
    console.log(`[rate] 429 — waiting ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
    return riotFetch(url);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Riot API ${res.status}: ${body}`);
  }
  return res.json();
}

// GET /api/live-game?riotId=jacob%23supp
app.get('/api/live-game', async (req, res) => {
  const { riotId } = req.query;
  if (!riotId || typeof riotId !== 'string') {
    return res.status(400).json({ error: 'Missing riotId (e.g. ?riotId=jacob%23supp)' });
  }

  const hash = riotId.indexOf('#');
  if (hash === -1) {
    return res.status(400).json({ error: 'riotId must be Name#Tag' });
  }
  const gameName = riotId.slice(0, hash);
  const tagLine = riotId.slice(hash + 1);

  try {
    const account = await riotFetch(
      `${AMERICAS}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );

    const summoner = await riotFetch(
      `${NA}/lol/summoner/v4/summoners/by-puuid/${account.puuid}`
    );

    const game = await riotFetch(
      `${NA}/lol/spectator/v5/active-games/by-summoner/${summoner.id}`
    );

    const participants = await Promise.all(
      game.participants.map(async (p, idx) => {
        const acct = await riotFetch(
          `${AMERICAS}/riot/account/v1/accounts/by-puuid/${p.puuid}`
        );
        return {
          name: acct.gameName,
          tag: acct.tagLine,
          teamId: p.teamId,
          participantIndex: idx,
        };
      })
    );

    res.json(participants);
  } catch (err) {
    if (err.message.includes('Riot API 404')) {
      return res.status(404).json({ error: 'Not in a live game (or streamer mode is on)' });
    }
    if (err.message.startsWith('Riot API')) {
      return res.status(502).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (${isProduction ? 'production' : 'development'})`);
});
