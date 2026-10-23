import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLat, degreesLong } from 'satellite.js';

/**
 * Live position of the International Space Station.
 *
 * The ISS's published orbit (a "TLE") is fetched once from CelesTrak, with
 * wheretheiss.at as a backup, and cached in the browser for 12 hours. The exact
 * position is then calculated on the visitor's device for any moment (standard
 * SGP4 orbit model), so it moves smoothly without polling a server.
 */
export interface IssState {
  lat: number;
  lng: number;
  heightKm: number;
  speedKmh: number;
}

type SatRec = ReturnType<typeof twoline2satrec>;
const CACHE_KEY = 'iss-tle-v1';
const MAX_AGE = 12 * 3600 * 1000;

async function fetchTle(): Promise<[string, string]> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (Date.now() - c.at < MAX_AGE && c.l1 && c.l2) return [c.l1, c.l2];
    }
  } catch {}
  const sources: (() => Promise<[string, string]>)[] = [
    async () => {
      const t = await (await fetch('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE')).text();
      const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const l1 = lines.find((l) => l.startsWith('1 25544'));
      const l2 = lines.find((l) => l.startsWith('2 25544'));
      if (!l1 || !l2) throw new Error('CelesTrak: no TLE');
      return [l1, l2];
    },
    async () => {
      const j = await (await fetch('https://api.wheretheiss.at/v1/satellites/25544/tles')).json();
      if (!j.line1 || !j.line2) throw new Error('wheretheiss.at: no TLE');
      return [j.line1, j.line2];
    },
  ];
  for (const s of sources) {
    try {
      const tle = await s();
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), l1: tle[0], l2: tle[1] }));
      } catch {}
      return tle;
    } catch {}
  }
  throw new Error('ISS orbit data unavailable');
}

export class IssTracker {
  private rec: SatRec | null = null;

  async load(): Promise<boolean> {
    try {
      const [l1, l2] = await fetchTle();
      this.rec = twoline2satrec(l1, l2);
      return !!this.at(new Date());
    } catch {
      return false;
    }
  }

  get ready() {
    return !!this.rec;
  }

  at(date: Date): IssState | null {
    if (!this.rec) return null;
    const pv = propagate(this.rec, date);
    if (!pv || typeof pv.position === 'boolean' || !pv.position) return null;
    const g = eciToGeodetic(pv.position, gstime(date));
    const v = pv.velocity && typeof pv.velocity !== 'boolean' ? pv.velocity : { x: 0, y: 0, z: 0 };
    return {
      lat: degreesLat(g.latitude),
      lng: degreesLong(g.longitude),
      heightKm: g.height,
      speedKmh: Math.hypot(v.x, v.y, v.z) * 3600,
    };
  }
}
