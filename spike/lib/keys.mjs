// The game's keys in a session, and a game controller's buttons
// (lib/gamepad.mjs), for the page's Keys panel (render.html) and the site's
// landing page. Read from the game: its table of the 36 keys it
// reads in a session (DS:2FA5, key codes, and DS:2FC9, their bits in
// DS:2349-234E), the code that tests each bit, and probes that press the keys
// in a Quick Race (probes/p5-keys.mjs). docs/memory-map.md, "Keys".
//
// The game also reads F7-F10, Q, V and Ctrl in a session; what they do is
// not decoded, so they are not listed.

export const KEY_GROUPS = [
  {
    name: 'Driving',
    keys: [
      ['A  Z', 'Accelerate, brake'],
      [',  .', 'Steer left, right'],
      ['Space', 'Change gear when Auto Gears is off: up with A held, down without it'],
      ['Space', 'In the pits: drop the car off its jacks'],
      ['Enter', 'Ask for a pit stop (the lamp at the bottom right of the cockpit)'],
    ],
  },
  {
    name: 'Driving aids',
    note: 'Each key turns one on or off, as far as the skill level allows. The game has no traction control.',
    keys: [
      ['F1', 'Auto brakes'],
      ['F2', 'Auto gears'],
      ['F3', 'Self-righting spins'],
      ['F4', 'Indestructible car'],
      ['F5', 'Best line, dotted on the track'],
      ['F6', 'Suggested gear'],
    ],
  },
  {
    name: 'Views',
    keys: [
      ['←  →', 'TV view, back to the cockpit'],
      ['Page Down', 'Chase view'],
      ['Delete', 'Reverse view'],
      ['↑  ↓', 'Watch the car ahead, behind'],
      ['Home', 'Back to your own car'],
      ['N', "Show the name of the driver you are watching"],
      ['G', 'The dash shows the drivers ahead and behind'],
      ['R', 'Instant replay'],
    ],
  },
  {
    name: 'Game',
    keys: [
      ['P', 'Pause'],
      ['Esc', 'Leave the session, back to the menus'],
      ['T', 'Ground texture on or off'],
      ['D', "Detail of the game's own drawing (Screen: Original game): fewer trackside objects, in four steps"],
      ['=  -', 'Sound up, down: everything, no tyre squeal, off'],
      ['O', 'Processor occupancy: how busy the game is'],
    ],
  },
  {
    name: 'Game controller',
    note: 'Any controller the browser sees: press one of its buttons once so that it does. Buttons as on an Xbox pad; on a PlayStation pad A is cross, B circle, X square and Y triangle.',
    keys: [
      ['Left stick', 'Steer'],
      ['RT  LT', 'Accelerate, brake (the right stick up and down does the same)'],
      ['RB  LB', 'Change gear up, down when Auto Gears is off'],
      ['A', 'In the pits: drop the car off its jacks'],
      ['X', 'Ask for a pit stop'],
      ['Y', 'Chase view'],
      ['D-pad', 'As the arrow keys: left the TV view, right back to the cockpit, up and down the car ahead and behind'],
      ['B', 'Back to your own car'],
      ['Start', 'Pause'],
      ['Back', 'Leave the session'],
      ['D-pad  A', 'In the menus: move, choose'],
      ['B', 'In the menus: Esc (it skips the intro)'],
    ],
  },
];

/** The groups as HTML tables (for a page's Keys panel). */
export function keysHtml(groups = KEY_GROUPS) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return groups.map((g) => `<h3>${esc(g.name)}</h3>${g.note ? `<p>${esc(g.note)}</p>` : ''}<table>${g.keys
    .map(([k, what]) => `<tr><td>${k.split(/\s{2,}/).map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</td><td>${esc(what)}</td></tr>`).join('')}</table>`).join('');
}
