// node --no-warnings tools/tests/bandThemes.test.ts
// Locks the band-theme (artist Easter-egg) matcher + resolver: the RadioText →
// artist detection the whole feature hinges on. Pure leaf, no RN.
import { normalizeRt, matchEggId, resolveEgg, eggTokens, buildEggs, EGG_MENU, type EggPalette } from '../../src/components/carfm/bandThemes.ts';

const PAL: EggPalette = { text: '#111', dim: '#888', border: '#ccc', blue: '#4A9EFF', blueFill: 'rgba(74,158,255,0.18)' };

let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ` — ${extra}` : '')); if (!cond) fail++; };

// normalize
ok('normalize lowercases + strips punctuation', normalizeRt('AC/DC - Thunderstruck!') === 'ac dc   thunderstruck ');
ok('normalize handles null', normalizeRt(null) === '');

// detection: real RadioText shapes
ok('AC/DC via slash', matchEggId('AC/DC - Thunderstruck') === 'AC/DC');
ok('AC/DC via "acdc"', matchEggId('Now: ACDC Back In Black') === 'AC/DC');
ok('Nirvana anywhere in the text', matchEggId('Now Playing — Nirvana / Lithium') === 'Nirvana');
ok('Talking Heads', matchEggId('talking heads — once in a lifetime') === 'Talking Heads');
ok('Nine Inch Nails', matchEggId('NINE INCH NAILS - Hurt') === 'Nine Inch Nails');
ok('The Beatles', matchEggId('The Beatles - Hey Jude') === 'The Beatles');

// non-matches + edges
ok('no match → null', matchEggId('Taylor Swift - Anti-Hero') === null);
ok('empty RadioText → null', matchEggId('') === null);
ok('whitespace RadioText → null', matchEggId('   ') === null);
// substring false-positive guard: "beatles" must be a real substring, not fuzzy
ok('unrelated text does not match beatles', matchEggId('beat it - michael jackson') === null);

// forced override wins over detection (secret panel)
ok('forced id overrides detection', matchEggId('AC/DC', 'Nirvana') === 'Nirvana');
ok('forced id with no RadioText', matchEggId('', 'Talking Heads') === 'Talking Heads');

// first match wins when two artists are present (registry order)
ok('first match wins (AC/DC before Nirvana)', matchEggId('acdc and nirvana medley') === 'AC/DC');

// resolveEgg: modes merge + off suppression
ok('resolve returns null when off', resolveEgg({ rt: 'AC/DC', dark: true, pal: PAL, off: true }) === null);
{
  const dark = resolveEgg({ rt: 'AC/DC', dark: true, pal: PAL });
  ok('AC/DC dark merges Back-in-Black pageBg', dark?.pageBg === '#000000', `pageBg=${dark?.pageBg}`);
  ok('AC/DC dark restates uiAccent silver', dark?.uiAccent === '#C9C9C9');
  const light = resolveEgg({ rt: 'AC/DC', dark: false, pal: PAL });
  ok('AC/DC light has no pageBg override', light?.pageBg === undefined);
  ok('AC/DC light adds genre outline', !!light?.genreOutline);
}

// eggTokens: uiAccent recolours interactive tokens; default otherwise
{
  const acdcDark = resolveEgg({ rt: 'AC/DC', dark: true, pal: PAL })!;
  ok('eggTokens applies uiAccent', eggTokens(acdcDark, PAL).blue === '#C9C9C9');
  const nirvana = resolveEgg({ rt: 'nirvana', dark: false, pal: PAL })!;
  ok('eggTokens keeps default blue when no uiAccent', eggTokens(nirvana, PAL).blue === PAL.blue);
}

// palette-derived themes resolve against live tokens
ok('Nirvana accent = default text token', buildEggs(PAL).find((e) => e.id === 'Nirvana')?.accent === PAL.text);

// secret menu covers all five
ok('EGG_MENU lists five pun labels', EGG_MENU.length === 5 && EGG_MENU.every((m) => m.id && m.label));

console.log(fail === 0 ? '\nbandThemes: ALL PASS' : `\nbandThemes: ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
