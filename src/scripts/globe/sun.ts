/**
 * Where the Sun is directly overhead right now (the "subsolar point").
 * Low-precision solar formulae from the Astronomical Almanac — accurate to
 * well under a degree, far more than enough to place day and night on the globe.
 */
export function subsolarPoint(date = new Date()): { lat: number; lng: number } {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const g = (357.529 + 0.98560028 * d) * rad; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude (deg)
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * rad; // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad; // right ascension (deg)
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / rad;
  const gmst = (280.46061837 + 360.98564736629 * d) % 360; // Greenwich sidereal time (deg)
  const lng = ((((ra - gmst) % 360) + 540) % 360) - 180;
  return { lat: dec, lng };
}
