/**
 * RDS Programme Type (PTY) labels. The 5-bit code means DIFFERENT things in
 * North America (RBDS, NRSC-4-B Annex F) vs everywhere else (RDS, IEC 62106) —
 * "5" is Rock in Madison and Education in Munich. The face picks the table by
 * ITU region (region 2 = Americas = RBDS).
 */

const RBDS: string[] = [
  '', 'News', 'Information', 'Sports', 'Talk', 'Rock', 'Classic Rock',
  'Adult Hits', 'Soft Rock', 'Top 40', 'Country', 'Oldies', 'Soft',
  'Nostalgia', 'Jazz', 'Classical', 'R&B', 'Soft R&B', 'Foreign Language',
  'Religious Music', 'Religious Talk', 'Personality', 'Public', 'College',
  'Spanish Talk', 'Spanish Music', 'Hip-Hop', '', '', 'Weather',
  'Emergency Test', 'Emergency',
];

const RDS: string[] = [
  '', 'News', 'Current Affairs', 'Information', 'Sport', 'Education', 'Drama',
  'Culture', 'Science', 'Varied', 'Pop Music', 'Rock Music', 'Easy Listening',
  'Light Classical', 'Serious Classical', 'Other Music', 'Weather', 'Finance',
  "Children's", 'Social Affairs', 'Religion', 'Phone-In', 'Travel', 'Leisure',
  'Jazz Music', 'Country Music', 'National Music', 'Oldies Music', 'Folk Music',
  'Documentary', 'Alarm Test', 'Alarm',
];

/** PTY code -> display label ('' for none/unassigned). region2 = Americas (RBDS). */
export function ptyLabel(pty: number | undefined, region2: boolean): string {
  if (pty == null || pty <= 0 || pty > 31) return '';
  return (region2 ? RBDS : RDS)[pty] ?? '';
}
