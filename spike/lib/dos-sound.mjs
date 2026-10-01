// The DOS game's sound events, for the page's Amiga sound (lib/amiga-sound.mjs).
//
// In a session the game's race sound driver (xsound.bin, the AdLib asound.bin
// in the site's bundle) sits at segment 8CE6h of the image. The game starts
// an effect through 19ED:2D73 (DX = 0Ch, AX = the effect, from SS:018C),
// which calls the driver at 0532h; 19ED:2D8C and 2E32 stop effects through
// the driver at 0556h (DX = 10h). Before some effects the game writes their
// details into the first bytes of the driver (es:[0Eh] the kerb's side,
// es:[12h] the tyres' volume), and it keeps the car a passing sound is for
// at DS:0956.
//
// driverHook() counts those calls: it puts a near jump at 0532h and 0556h to
// a few bytes past the driver's end (1BD0h; the buffer is 1C40h bytes, room
// for the largest driver, aingame.bin, 1BC9h bytes) that add one to a byte
// per effect (1C00h starts, 1C10h stops) and then do what the replaced
// instruction did. The page reads the counters every frame. The hook checks
// the driver's bytes first, and is put in again when the game loads the
// driver again.
//
// engineSound() reads the engine sound's state and revs (DS:0948, DS:0054),
// which the game's timer routine (8B6E:03D0) moves as the Amiga's VBlank
// routine moves its own (lib/amiga-race.mjs).

const DRIVER_SEG = 0x8ce6;
const START = 0x0532, STOP = 0x0556;
const STUB = 0x1bd0, COUNTS = 0x1c00, STOPS = 0x1c10;
// mov byte cs:[0079], FF at both entries (asound.bin)
const ENTRY = [0x2e, 0xc6, 0x06, 0x79, 0x00, 0xff];
const AFTER = { [START]: [0x1e, 0x56, 0x57, 0x03, 0xc0], [STOP]: [0x1e, 0x56, 0x57, 0x83, 0xf8] };

function stub(at, counts, back) {
  const b = [
    ...ENTRY,                                 // mov byte cs:[0079], FF (the replaced instruction)
    0x53,                                     // push bx
    0x8b, 0xd8,                               // mov bx, ax (the effect)
    0x83, 0xe3, 0x0f,                         // and bx, 0F
    0x2e, 0xfe, 0x87, counts & 0xff, counts >> 8, // inc byte cs:[bx + counts]
    0x5b,                                     // pop bx
    0xe9, 0, 0,                               // jmp back
  ];
  const rel = (back - (at + b.length)) & 0xffff;
  b[b.length - 2] = rel & 0xff; b[b.length - 1] = rel >> 8;
  return b;
}
const jump = (from, to) => { const rel = (to - (from + 3)) & 0xffff; return [0xe9, rel & 0xff, rel >> 8, 0x90, 0x90, 0x90]; };

export function driverHook(mem) {
  const heap = () => mem.heap();
  const base = () => mem.memBase + ((DRIVER_SEG + mem.imageSeg) << 4);
  const startStub = stub(STUB, COUNTS, START + 6);
  const stopAt = STUB + startStub.length;
  const stopStub = stub(stopAt, STOPS, STOP + 6);
  const at = (off, bytes) => { const H = heap(), b = base(); return bytes.every((v, i) => H[b + off + i] === v); };
  const put = (off, bytes) => heap().set(bytes, base() + off);
  const patched = () => at(START, jump(START, STUB)) && at(STOP, jump(STOP, stopAt)) && at(STUB, startStub) && at(stopAt, stopStub);
  let last = null;
  return {
    /** The race driver is loaded, as the game left it (unhooked) or with the hook in. */
    get present() {
      if (patched()) return true;
      return [START, STOP].every((e) => at(e, ENTRY) && at(e + 6, AFTER[e]));
    },
    get installed() { return patched(); },
    /** Put the hook in (true when it is in). The counters start from where they are. */
    install() {
      if (patched()) return true;
      if (![START, STOP].every((e) => at(e, ENTRY) && at(e + 6, AFTER[e]))) return false;
      put(STUB, startStub);
      put(stopAt, stopStub);
      put(COUNTS, new Array(32).fill(0));
      put(START, jump(START, STUB));
      put(STOP, jump(STOP, stopAt));
      last = null;
      return true;
    },
    uninstall() {
      if (!patched()) return;
      put(START, ENTRY);
      put(STOP, ENTRY);
      last = null;
    },
    /**
     * The calls since the last read: { starts: [n per effect 0-15], stops: [...] },
     * or null when the hook is not in.
     */
    take() {
      if (!patched()) { last = null; return null; }
      const H = heap(), b = base();
      const now = Array.from(H.subarray(b + COUNTS, b + COUNTS + 32));
      const prev = last ?? now;
      last = now;
      const d = now.map((v, i) => (v - prev[i]) & 0xff);
      return { starts: d.slice(0, 16), stops: d.slice(16, 32) };
    },
    /** What the game wrote in the driver's first bytes: the kerb's side and the tyres' volume. */
    params() {
      const H = heap(), b = base();
      return { side: H[b + 0x0e] | (H[b + 0x0f] << 8), tyreVolume: H[b + 0x12] };
    },
    /** The driver's tyre countdown (cs:[007Bh]; 20 driver ticks after each tyre start). */
    get tyresOn() { const H = heap(), b = base(); return (H[b + 0x7b] | (H[b + 0x7c] << 8)) !== 0; },
  };
}

/**
 * The game's sound flags: on (SS:018E = 0: a session runs with the game's
 * sounds on; 80h in the menus, and set again when the session ends) and
 * left (SS:124E bit 10h: the player left the session with Esc).
 */
export function soundFlags(mem) {
  const H = mem.heap(), ss = mem.memBase + (mem.SS << 4);
  return { on: H[ss + 0x18e] === 0, left: (H[ss + 0x124e] & 0x10) !== 0 };
}

/** The engine sound: { state (DS:0948), revs (DS:0054) }, and the view (DS:0981; C0h: the TV view, no engine sound). */
export function engineSound(mem) {
  const H = mem.heap(), ds = mem.memBase + (mem.DS << 4);
  return { state: H[ds + 0x948], revs: H[ds + 0x54] | (H[ds + 0x55] << 8), view: H[ds + 0x981] };
}

/** The speed (car+10h) of the car a passing sound was started for (DS:0956), or null. */
export function passingSpeed(mem) {
  const H = mem.heap(), ds = mem.memBase + (mem.DS << 4);
  const car = H[ds + 0x956] | (H[ds + 0x957] << 8);
  if (!car) return null;
  return H[ds + car + 0x10] | (H[ds + car + 0x11] << 8);
}
