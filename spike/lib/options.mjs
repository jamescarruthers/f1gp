// The page's address options (render.html), all but bundle: their values,
// what each does, and how the Options panel sets it. render.html builds the
// panel from this table and keeps the choices with menuChoices (saves.mjs);
// tests/options.test.mjs checks the table against the page's parser and its
// comment block.
//
// Each option: name (the address key), group, label, values ([value, label]),
// def (the default, or (c) => the default for c = { style, layout }),
// read(opts) (the value in use, from the page's opts), text, note, and
//   styled: the style sets it unless it is chosen (opts[name + 'Param'])
//   reload: it applies only when the page loads again
//   kept: false when the choice lasts this visit only
//
// Plain ES module, no DOM.

const byStyle = (modern, classic) => (c) => (c.style === 'classic' ? classic : modern);
const oneOf = (v, known, other) => (known.includes(v) ? v : other);
const bit = (b) => (b ? '1' : '0');

// [group, heading, a line under the heading]
export const GROUPS = [
  ['screen', 'Screen'],
  ['look', 'Look', 'These change our new view only.'],
  ['cockpit', 'Cockpit'],
  ['sound', 'Sound'],
  ['controls', 'Controls'],
  ['pc', 'The PC'],
  ['speed', 'Game speed'],
  ['saves', 'Saves'],
  ['tests', 'For tests'],
];

export const OPTIONS = [
  { name: 'layout', group: 'screen', label: 'Layout', reload: true, def: 'single',
    values: [['single', 'One screen'], ['side', 'Side by side'], ['gl', 'New view only'], ['overlay', 'New view over the game']],
    read: (o) => oneOf(o.layout, ['single', 'gl', 'overlay'], 'side'),
    text: 'One screen shows the game\'s screen in the menus and our new view in the car. The others compare the two: side by side, ours alone, or ours laid half see-through over the game\'s.' },
  { name: 'screen', group: 'screen', label: 'Screen', def: (c) => (c.layout === 'single' ? 'new' : 'original'),
    values: [['new', 'New view'], ['original', 'Original game']],
    read: (o) => (o.screen === 'new' ? 'new' : 'original'),
    text: 'New view stops the game drawing its own 3D scene, and on one screen shows ours in its place, under the game\'s cockpit and dash. Original game draws as it always did.' },
  { name: 'framing', group: 'screen', label: 'Shape', styled: true, def: byStyle('wide', 'original'),
    values: [['wide', 'Wide'], ['original', '4:3, as the game']],
    read: (o) => (o.framing === 'original' || o.framing === 'screen' ? 'original' : 'wide'),
    text: 'The shape of our view. Wide keeps the game\'s height and shows more at the sides; 4:3 matches the game, with its cockpit sides.',
    note: 'Not in the overlay layout, which uses the game\'s shape.' },
  { name: 'smooth', group: 'screen', label: 'Smooth motion', def: '1',
    values: [['1', 'On'], ['0', 'Off']], read: (o) => bit(o.smooth),
    text: 'Moves our view smoothly between the game\'s frames, at your screen\'s rate. It shows the game one frame late.' },

  { name: 'style', group: 'look', label: 'Style', def: 'modern',
    values: [['modern', 'Modern: 3D cars'], ['classic', 'Classic: as the original']], read: (o) => o.style,
    text: 'Sets the whole look at once. Modern draws every car in 3D, with turning wheels, smooth haze, real mirrors and shadows; Classic draws as the game does, in 4:3.',
    note: 'Each choice that says "From the style" follows it.' },
  { name: 'haze', group: 'look', label: 'Haze', styled: true, def: byStyle('smooth', 'classic'),
    values: [['smooth', 'Smooth'], ['classic', 'In steps, as the game'], ['off', 'None']],
    read: (o) => oneOf(o.haze, ['smooth', 'classic'], 'off'),
    text: 'Fades distant things into haze, with the game\'s own haze tables: smoothly, in the game\'s steps, or not at all.',
    note: 'Needs the track from the game\'s memory, with cars or trackside objects shown.' },
  { name: 'texture', group: 'look', label: 'Ground texture', styled: true, def: byStyle('smooth', 'classic'),
    values: [['smooth', 'Smooth'], ['classic', 'Whole shades, as the game'], ['off', 'Flat']],
    read: (o) => oneOf(o.texture, ['smooth', 'classic'], 'off'),
    text: 'The pattern on the road and grass. Smooth blends neighbouring shades; the game uses whole shades.',
    note: 'Needs the game\'s own texture on (press T in the car) and the track from the game\'s memory.' },
  { name: 'crowd', group: 'look', label: 'Crowd', styled: true, def: byStyle('stands', 'sharp'),
    values: [['stands', 'On the stands, coarser far away'], ['sharp', 'On the stands, sharp'], ['screen', 'Fixed to the screen, as the game']],
    read: (o) => oneOf(o.crowd, ['sharp', 'screen'], 'stands'),
    text: 'Where the crowd is painted: on the stands themselves, or fixed to the screen as the game does it.',
    note: 'Needs trackside objects shown, at a circuit with a crowd.' },
  { name: 'poles', group: 'look', label: 'Poles and posts', styled: true, def: byStyle('solid', 'pixel'),
    values: [['solid', 'Six inches wide'], ['pixel', 'One pixel, as the game']],
    read: (o) => (o.poles === 'pixel' ? 'pixel' : 'solid'),
    text: 'How wide flag poles and posts are: six inches, but never thinner than one of the game\'s pixels, or one pixel, as the game draws them.',
    note: 'Needs trackside objects shown.' },
  { name: 'shade', group: 'look', label: 'Sunlit faces', styled: true, def: byStyle('on', 'off'),
    values: [['on', 'On'], ['off', 'Off, as the game']], read: (o) => o.shade,
    text: 'A fixed sun lights the faces of stands, buildings and cars a little. Off colours them flat, as the game does.' },
  { name: 'shadows', group: 'look', label: 'Shadows', styled: true, def: byStyle('on', 'off'),
    values: [['on', 'On'], ['off', 'None']], read: (o) => o.shadows,
    text: 'Stands, buildings, bridges and walls cast shadows from the same sun on the road, the ground and each other. In the cockpit, the dash darkens in shadow.',
    note: 'Needs the track from the game\'s memory.' },
  { name: 'lod', group: 'look', label: 'Distant shapes', styled: true, def: byStyle('steady', 'game'),
    values: [['steady', 'Steady, no popping'], ['game', 'As the game picks']], read: (o) => o.lod,
    text: 'Steady draws the near version of each tree and board at every distance, so they do not pop or flicker. The game swaps in simpler ones far away, which is less to draw.',
    note: 'Needs trackside objects shown.' },

  { name: 'cockpit', group: 'cockpit', label: 'Cockpit', styled: true, def: byStyle('smooth', 'pixels'),
    values: [['smooth', 'Smoothed'], ['pixels', 'Pixels, as the game']], read: (o) => o.cockpit,
    text: 'How the game\'s cockpit, dash and messages look over our view: enlarged through a filter made for pixel art, or as square pixels.',
    note: 'Needs one screen and the new view.' },
  { name: 'mirrors', group: 'cockpit', label: 'Mirrors', styled: true, def: byStyle('real', 'game'),
    values: [['real', 'Real rear view'], ['game', 'As the game']], read: (o) => o.mirrors,
    text: 'Real shows a rear view drawn by our renderer, curved a little like a real mirror, under a sheen of glass. As the game shows its fixed backdrop, with the cars behind as flat pictures.',
    note: 'Needs one screen, the new view, the cockpit view and cars shown.' },

  { name: 'audio', group: 'sound', label: 'Play sound', reload: true, def: 'own',
    values: [['own', 'Yes'], ['off', 'No']], read: (o) => (o.audio === 'own' ? 'own' : 'off'),
    text: 'Plays the game\'s sound in the page. It starts with your first key or click.' },
  { name: 'sound', group: 'sound', label: 'Sound', def: 'amiga',
    values: [['amiga', 'Amiga'], ['amiga-clean', 'Amiga, no filter'], ['adlib', 'PC: AdLib']], read: (o) => o.sound,
    text: 'The Amiga version\'s music and race sounds, played from the game\'s events, with or without the Amiga 500\'s filter. Or the PC version\'s own AdLib sound.',
    note: 'Needs Play sound. Our PC has no AdLib.' },

  { name: 'pad', group: 'controls', label: 'Game controller', def: 'auto',
    values: [['auto', 'Use it'], ['off', 'Ignore it']], read: (o) => o.pad,
    text: 'Once the browser sees a controller (press one of its buttons), its stick steers, its triggers speed up and brake, and its buttons press the game\'s keys. A driving key on the keyboard takes control back.',
    note: 'The Keys panel lists its buttons.' },
  { name: 'manual', group: 'controls', label: 'Manual check', reload: true, def: 'auto',
    values: [['auto', 'Answer it for me'], ['off', 'I answer it']], read: (o) => (o.manual === 'auto' ? 'auto' : 'off'),
    text: 'At the start the game asks for a word from its manual. The page can pick the English manual, type the word, and answer the joystick question with Use Keys.' },

  { name: 'machine', group: 'pc', label: 'PC', reload: true, def: 'dosbox',
    values: [['dosbox', 'DOSBox, from js-dos'], ['rust', 'Ours, in Rust']], read: (o) => o.machine,
    text: 'The PC the game runs on: js-dos\'s DOSBox, or our own 286 PC written in Rust. Ours skips the intro and has no AdLib, so the Amiga sound plays.' },
  { name: 'r3d', group: 'pc', label: 'Game\'s 3D drawn by', def: 'game',
    values: [['game', 'The game\'s own code'], ['ours', 'Our Rust port'], ['gpu', 'Our port, finer, in WebGPU']], read: (o) => o.r3d,
    text: 'Who draws the 3D scene on the game\'s own screen: the game\'s code, our Rust port of it (the same picture, faster), or our port at a higher resolution, painted by WebGPU.',
    note: 'Needs our PC and the Original game screen. WebGPU needs a reload unless the page started with it.' },
  { name: 'scale', group: 'pc', label: 'WebGPU detail', def: 'auto',
    values: [['auto', 'Fit the screen'], ['1', '1x, the game\'s pixels'], ['2', '2x'], ['3', '3x'], ['4', '4x'], ['5', '5x'], ['6', '6x']],
    read: (o) => String(o.scale),
    text: 'How finely the WebGPU view is drawn, counted in the game\'s pixels. Fit the screen matches your screen\'s pixels.',
    note: 'Needs our PC and the WebGPU view.' },
  { name: 'art', group: 'pc', label: 'Enlarged art', def: 'pixels',
    values: [['pixels', 'Square pixels'], ['smooth', 'Smoothed']], read: (o) => o.art,
    text: 'Wheels, helmets, boards and trees where they are drawn at least one and a half times the size of their art: as square pixels, or smoothed. Smoothed turns the steps along the art\'s edges into slopes and curves, as the Cockpit filter does, but with hard edges in the game\'s own colours. Boards, digits and thin stripes keep their square corners.',
    note: 'Needs our PC and the WebGPU view, at 2x or more to show much. Square pixels while Check WebGPU frames is on.' },
  { name: 'cardetail', group: 'pc', label: 'Car detail', def: 'scale',
    values: [['scale', 'As the game would, that much finer'], ['all', '3D models at every distance'], ['game', 'As the game']], read: (o) => o.cardetail,
    text: 'How far the cars keep their 3D model before the game draws them as flat pictures. The game swaps at 32 feet in the cockpit and 52 feet outside; the first choice keeps the model that many times further at the WebGPU detail, the second keeps it at every distance.',
    note: 'Needs our PC and the WebGPU view. The cars in the mirrors stay as the game draws them.' },

  { name: 'fps', group: 'speed', label: 'Frame rate', def: '30',
    values: [['30', '30 a second'], ['25', '25 a second'], ['20', '20 a second'], ['15', '15 a second'], ['10', '10 a second'], ['game', 'The game\'s own (15 in a Quick Race)']],
    read: (o) => (o.fps === null ? 'game' : String(o.fps)), extra: (v) => `${v} a second`,
    text: 'The game\'s frame rate, in place of the one in the game\'s own options. 30 is the most its physics allows.',
    note: 'Set while the game is in its menus, so it applies from the next race. Going back to the game\'s own needs a reload.' },
  { name: 'cycles', group: 'speed', label: 'Emulated CPU speed', reload: true, def: 'auto',
    values: [['auto', 'Slower when it can'], ['fixed', 'Fixed']], read: (o) => (o.cycles === 'auto' ? 'auto' : 'fixed'),
    text: 'Slower when it can slows the emulated PC while our view or our port draws the 3D, to leave the browser time to draw, and speeds it up when the game needs more. Fixed keeps one speed: on DOSBox the one set in the game\'s files, on our PC 20,000 cycles a millisecond.' },
  { name: 'sleep', group: 'speed', label: 'Emulator waits', reload: true, def: 'timer',
    values: [['timer', 'On a timer'], ['spin', 'Busy, as js-dos does']], read: (o) => o.sleep,
    text: 'How DOSBox waits out the rest of each millisecond: on a timer, or by passing messages to itself as js-dos does, which keeps the page busy.',
    note: 'Needs DOSBox.' },

  { name: 'saves', group: 'saves', label: 'Keep saved games', reload: true, kept: false, def: 'on',
    values: [['on', 'Yes'], ['off', 'No, this visit only']], read: (o) => (o.saves ? 'on' : 'off'),
    text: 'Keeps the files the game writes (saved games, names, track records, car setups and its options) in this browser for your next visit. The Saves button lists them.',
    note: 'No also leaves out the saves from earlier visits until you choose Yes again; they are not deleted.' },

  { name: 'source', group: 'tests', label: 'Build the track from', reload: true, kept: false, def: 'memory',
    values: [['memory', 'The game\'s memory'], ['file', 'The track file']], read: (o) => (o.source === 'memory' ? 'memory' : 'file'),
    text: 'The game\'s memory gives every part of the scene, with the game\'s colours, sky and horizon. The track file gives only the road, kerbs and verges, as the first version of our view did.' },
  { name: 'cars', group: 'tests', label: 'Cars', reload: true, kept: false, def: '1',
    values: [['1', 'Shown'], ['0', 'Hidden']], read: (o) => bit(o.cars),
    text: 'Draws the cars in our view as the game does. Hiding them is for checks.',
    note: 'From the track file, cars are plain boxes.' },
  { name: 'objects', group: 'tests', label: 'Trackside objects', reload: true, kept: false, def: '1',
    values: [['1', 'Shown'], ['0', 'Hidden']], read: (o) => bit(o.objects),
    text: 'Draws the stands, buildings, trees and boards. Hiding them is for checks.',
    note: 'Needs the track from the game\'s memory.' },
  { name: 'gpucheck', group: 'tests', label: 'Check WebGPU frames', kept: false, def: '0',
    values: [['0', 'Off'], ['1', 'On']], read: (o) => bit(o.gpucheck),
    text: 'For probes: the page reads back every 15th WebGPU frame, compares it with the game\'s own screen and puts the results in renderApp.gpu.',
    note: 'Needs the WebGPU view at 1x. Enlarged art is drawn as square pixels while it is on.' },
];

/** The options kept between visits, by name. */
export const KEPT = OPTIONS.filter((o) => o.kept !== false).map((o) => o.name);

/** An option's default, for c = { style, layout } as the address gives them. */
export function defaultOf(opt, c = {}) {
  return typeof opt.def === 'function' ? opt.def(c) : opt.def;
}

/** The value asked for a styled option: '' while it follows the style. */
export function askedOf(opt, o) {
  const p = o[`${opt.name}Param`];
  return p === null || p === undefined ? '' : opt.read({ ...o, [opt.name]: p });
}

/** The label of one of an option's values ('' is the style's). */
export function valueLabel(opt, v) {
  if (v === '') return 'From the style';
  const known = opt.values.find(([x]) => x === v);
  return known ? known[1] : opt.extra ? opt.extra(v) : v;
}

/**
 * q (URLSearchParams) with each kept option it does not set put at its
 * default, so that no choice kept in the browser applies (bench.html).
 */
export function withDefaults(q) {
  const c = { style: q.get('style') === 'classic' ? 'classic' : 'modern', layout: q.get('layout') ?? 'single' };
  for (const o of OPTIONS) if (o.kept !== false && !q.has(o.name)) q.set(o.name, defaultOf(o, c));
  return q;
}
