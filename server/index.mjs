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

async function riotFetch(url, stats = null) {
  console.log(`[riot] GET ${url}`);
  const res = await fetch(url, { headers: { 'X-Riot-Token': API_KEY } });
  console.log(`[riot] ${res.status} ${url}`);
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('retry-after') || '1', 10) * 1000;
    console.log(`[rate] 429 — waiting ${wait}ms`);
    if (stats) stats.waitedMs += wait;
    await new Promise(r => setTimeout(r, wait));
    return riotFetch(url, stats);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`[riot] ERROR ${res.status} on ${url} — body: ${body}`);
    throw new Error(`Riot API ${res.status}: ${body}`);
  }
  return res.json();
}

// GET /api/live-game?riotId=jacob%23supp
// Returns { puuid, inGame: bool, participants: [...] }
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
  console.log(`[live-game] lookup: ${gameName}#${tagLine}`);

  try {
    const account = await riotFetch(
      `${AMERICAS}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );

    let inGame = true;
    let participants = [];
    let game;

    try {
      game = await riotFetch(
        `${NA}/lol/spectator/v5/active-games/by-summoner/${account.puuid}`
      );
    } catch (spectatorErr) {
      if (spectatorErr.message.includes('Riot API 404')) {
        inGame = false;
      } else {
        throw spectatorErr;
      }
    }

    if (inGame && game) {
      participants = await Promise.all(
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
    }

    res.json({ puuid: account.puuid, inGame, participants });
  } catch (err) {
    if (err.message.includes('Riot API 404')) {
      return res.status(404).json({ error: 'Player not found' });
    }
    if (err.message.startsWith('Riot API')) {
      return res.status(502).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/match-history-ids?puuid=...&start=N
app.get('/api/match-history-ids', async (req, res) => {
  const { puuid, start = '0' } = req.query;
  if (!puuid) return res.status(400).json({ error: 'Missing puuid' });

  try {
    const matchIds = await riotFetch(
      `${AMERICAS}/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&count=5&start=${start}`
    );
    res.json({ matchIds });
  } catch (err) {
    if (err.message.startsWith('Riot API')) {
      return res.status(502).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/match?matchId=...
app.get('/api/match', async (req, res) => {
  const { matchId } = req.query;
  if (!matchId) return res.status(400).json({ error: 'Missing matchId' });

  try {
    const stats = { waitedMs: 0 };
    const match = await riotFetch(`${AMERICAS}/lol/match/v5/matches/${matchId}`, stats);

    const participants = await Promise.all(
      match.info.participants.map(async p => {
        const acct = await riotFetch(
          `${AMERICAS}/riot/account/v1/accounts/by-puuid/${p.puuid}`, stats
        );
        return {
          puuid: p.puuid,
          name: acct.gameName,
          tag: acct.tagLine,
          teamId: p.teamId,
          win: p.win,
          champion: p.championName,
          championId: p.championId,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          cs: p.totalMinionsKilled + p.neutralMinionsKilled,
          damage: p.totalDamageDealtToChampions,
          gold: p.goldEarned,
          visionScore: p.visionScore,
          items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
          teamPosition: p.teamPosition,
        };
      })
    );

    res.json({
      waitedMs: stats.waitedMs,
      matchId: match.metadata.matchId,
      gameDuration: match.info.gameDuration,
      gameStartTimestamp: match.info.gameStartTimestamp,
      queueId: match.info.queueId,
      participants,
    });
  } catch (err) {
    if (err.message.startsWith('Riot API')) {
      return res.status(502).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/current-rank?puuid=...
app.get('/api/current-rank', async (req, res) => {
  const { puuid } = req.query;
  if (!puuid) return res.status(400).json({ error: 'Missing puuid' });

  try {
    const entries = await riotFetch(
      `${NA}/lol/league/v4/entries/by-puuid/${puuid}`
    );
    const solo = entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
    if (!solo) return res.json(null);
    res.json({ tier: solo.tier, division: solo.rank, lp: solo.leaguePoints });
  } catch (err) {
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
