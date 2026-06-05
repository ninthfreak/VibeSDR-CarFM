export type BandType = 'ham' | 'broadcast' | 'utility';

export interface Band {
  lo: number;
  hi: number;
  name: string;
  type: BandType;
  bandLabel?: string;
  regions?: number[];
}

export const BAND_PLAN: Band[] = [
  { lo: 9000,      hi: 148500,    name: 'LW Broadcast Band',         type: 'broadcast' },
  { lo: 135700,    hi: 137800,    name: '2200m Ham Band',             type: 'ham',  bandLabel: '2200m' },
  { lo: 148500,    hi: 283500,    name: 'NDB / Navigational Beacons', type: 'utility' },
  { lo: 283500,    hi: 525000,    name: 'NDB / Maritime Beacons',     type: 'utility' },
  { lo: 472000,    hi: 479000,    name: '630m Ham Band',              type: 'ham',  bandLabel: '630m' },
  { lo: 525000,    hi: 1605000,   name: 'AM Broadcast Band',          type: 'broadcast', regions: [2, 3] },
  { lo: 525000,    hi: 1705000,   name: 'AM Broadcast Band',          type: 'broadcast', regions: [1] },
  { lo: 1800000,   hi: 2000000,   name: '160m Ham Band',              type: 'ham',  bandLabel: '160m' },
  { lo: 2300000,   hi: 2495000,   name: '120m Tropical Broadcast',    type: 'broadcast' },
  { lo: 2495000,   hi: 2850000,   name: '90m Tropical Broadcast',     type: 'broadcast' },
  { lo: 3500000,   hi: 3800000,   name: '80m Ham Band',               type: 'ham',  bandLabel: '80m', regions: [1] },
  { lo: 3500000,   hi: 4000000,   name: '80m Ham Band',               type: 'ham',  bandLabel: '80m', regions: [2] },
  { lo: 3500000,   hi: 3900000,   name: '80m Ham Band',               type: 'ham',  bandLabel: '80m', regions: [3] },
  { lo: 3800000,   hi: 4000000,   name: '75m Broadcast Band',         type: 'broadcast', regions: [1, 3] },
  { lo: 3900000,   hi: 4000000,   name: '75m Broadcast Band',         type: 'broadcast', regions: [2] },
  { lo: 5250000,   hi: 5450000,   name: '60m Ham Band',               type: 'ham',  bandLabel: '60m' },
  { lo: 5900000,   hi: 6200000,   name: '49m Broadcast Band',         type: 'broadcast' },
  { lo: 7000000,   hi: 7200000,   name: '40m Ham Band',               type: 'ham',  bandLabel: '40m', regions: [1, 3] },
  { lo: 7000000,   hi: 7300000,   name: '40m Ham Band',               type: 'ham',  bandLabel: '40m', regions: [2] },
  { lo: 7200000,   hi: 7450000,   name: '41m Broadcast Band',         type: 'broadcast', regions: [1, 3] },
  { lo: 7300000,   hi: 7450000,   name: '41m Broadcast Band',         type: 'broadcast', regions: [2] },
  { lo: 9400000,   hi: 9900000,   name: '31m Broadcast Band',         type: 'broadcast' },
  { lo: 10100000,  hi: 10150000,  name: '30m Ham Band',               type: 'ham',  bandLabel: '30m' },
  { lo: 11600000,  hi: 12100000,  name: '25m Broadcast Band',         type: 'broadcast' },
  { lo: 13570000,  hi: 13870000,  name: '22m Broadcast Band',         type: 'broadcast' },
  { lo: 14000000,  hi: 14350000,  name: '20m Ham Band',               type: 'ham',  bandLabel: '20m' },
  { lo: 15100000,  hi: 15800000,  name: '19m Broadcast Band',         type: 'broadcast' },
  { lo: 18068000,  hi: 18168000,  name: '17m Ham Band',               type: 'ham',  bandLabel: '17m' },
  { lo: 17480000,  hi: 17900000,  name: '16m Broadcast Band',         type: 'broadcast' },
  { lo: 21000000,  hi: 21450000,  name: '15m Ham Band',               type: 'ham',  bandLabel: '15m' },
  { lo: 21450000,  hi: 21850000,  name: '13m Broadcast Band',         type: 'broadcast' },
  { lo: 24890000,  hi: 24990000,  name: '12m Ham Band',               type: 'ham',  bandLabel: '12m' },
  { lo: 26965000,  hi: 27405000,  name: '11m CB Band',                type: 'utility' },
  { lo: 28000000,  hi: 29700000,  name: '10m Ham Band',               type: 'ham',  bandLabel: '10m' },
];

export function getBandsAt(hz: number): Band[] {
  return BAND_PLAN.filter(b => hz >= b.lo && hz <= b.hi);
}

export function getPrimaryBandAt(hz: number): Band | null {
  const bands = getBandsAt(hz);
  if (!bands.length) return null;
  const ham = bands.find(b => b.type === 'ham');
  return ham ?? bands[0];
}
