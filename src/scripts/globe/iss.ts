import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLat, degreesLong } from 'satellite.js';

/**
 * Live position of the International Space Station.
 *
 * The ISS's published orbit (a "TLE") is downloaded by the site's build on GitHub
 * (refreshed daily) and served from this site as iss-tle.txt, so visitors' browsers
 * never contact a third-party server. The exact position is then calculated on the
 * visitor's device for any moment (standard SGP4 orbit model).
 */
export interface IssState {
  lat: number;
  lng: number;
  heightKm: number;
  speedKmh: number;
}

type SatRec = ReturnType<typeof twoline2satrec>;
/** Orbit data older than this is too inaccurate to show (e.g. if the daily refresh stopped). */
const MAX_AGE_DAYS = 10;

export class IssTracker {
  private rec: SatRec | null = null;

  constructor(private url: string) {}

  async load(): Promise<boolean> {
    try {
      const text = await (await fetch(this.url)).text();
      const lines = text.split(/\r?\n/).map((s) => s.trim());
      const l1 = lines.find((l) => l.startsWith('1 25544'));
      const l2 = lines.find((l) => l.startsWith('2 25544'));
      if (!l1 || !l2) return false;
      const rec = twoline2satrec(l1, l2);
      const year = rec.epochyr < 57 ? 2000 + rec.epochyr : 1900 + rec.epochyr;
      const epoch = Date.UTC(year, 0, 1) + (rec.epochdays - 1) * 86400000;
      if (Math.abs(Date.now() - epoch) > MAX_AGE_DAYS * 86400000) return false;
      this.rec = rec;
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
