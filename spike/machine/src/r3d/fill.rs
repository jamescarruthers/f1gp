//! The polygon filler (gp.exe 0F47:0999 to 1835, a far routine; docs/renderer-notes.md, section 7).
//!
//! A polygon is a ring of 4-byte entries in R from R:0010 up to R:000C: a flags word and a
//! pointer to an edge record. An edge record holds the edge's rows (the lower, larger, first),
//! its x at each end, then the x of each row from the lower row less one up, ending with 8000h.
//! An entry flagged 40h runs its edge the other way. The filler starts at the polygon's lowest
//! vertex, walks the ring forward for the left side and backward for the right, and fills each
//! row upward from the left x (drawn) to the right x (not drawn) until the two sides meet.
//!
//! Where the polygon runs along the screen's edge, a side has no edge for some rows: the filler
//! then reads a border list instead (R:04A8 ends a list of 0s, the left border; R:063A a list of
//! 320s, the right), allowed by the mode bits R:0640 (1 the bottom row, 2 the right side's left
//! border, 4 the left side's right border, 8 the top row). Rows from SS:0132 down go through the
//! cockpit's window (the row tables at SS:6364): each row has a screen offset (0: hidden), a
//! left and right limit and a gap. Colour 1Bh is the crowd: a strip of pixels copied row by row
//! when the stands are full (SS:124A), else colour 0Ah. Mode 0 walks the ring without borders.
//!
//! Each step below names the game's instruction it stands for.

use super::list;
use super::Mem;

/// Where a side's next x comes from.
#[derive(Clone, Copy, PartialEq)]
enum Walk {
    /// the full rules: border lists, the mode bits
    Bordered,
    /// mode 0: the ring alone
    Plain,
}

/// The filler's registers and memory.
struct Fill<'a> {
    m: Mem<'a>,
    /// the left side's next x (SI) and the right side's (BX), as offsets in R
    si: u16,
    bx: u16,
    /// the row below the one being drawn (DX: rows count down to 0)
    dx: u16,
    /// the back buffer (ES:DI): its segment, and the start of the row being drawn
    es: u16,
    di: u16,
    /// the caller's BP, then the cockpit's row tables (offsets in SS)
    bp: u16,
}

/// Fill the polygon at R:0010..R:000C (with DS the renderer's segment R, SS the game's, BP as the
/// game's caller has it). Returns AX as the game's routine leaves it.
pub fn fill(m: Mem, bp: u16) -> u16 {
    list::fill_begin(&m);
    let size = m.rw(0x0c).wrapping_sub(m.rw(0x10));
    if size == 0 {
        list::fill_end();
        return 0; // 09A2
    }
    let mut f = Fill {
        m,
        si: 0,
        bx: 0,
        dx: 0,
        es: 0,
        di: 0,
        bp,
    };
    f.run(size);
    list::fill_end();
    size
}

impl Fill<'_> {
    fn rw(&self, o: u16) -> u16 {
        self.m.rw(o)
    }
    fn set(&mut self, o: u16, v: u16) {
        self.m.set_rw(o, v)
    }
    fn flags(&self) -> u8 {
        self.m.rb(0x63e)
    }
    fn set_flags(&mut self, v: u8) {
        self.m.set_rb(0x63e, v)
    }
    fn ss_w(&self, o: u16) -> u16 {
        self.m.w(self.m.ss, o)
    }
    fn dx(&self) -> i16 {
        self.dx as i16
    }

    /// The ring's next entry forward from p (wrapping at R:02F8, the ring's end).
    fn forward(&self, p: u16) -> u16 {
        let p = p.wrapping_add(4);
        if p >= self.rw(0x2f8) {
            p.wrapping_sub(self.rw(0x2fa))
        } else {
            p
        }
    }
    /// The ring's entry backward from p (wrapping at R:02F6, its start).
    fn backward(&self, p: u16) -> u16 {
        let p = if p == self.rw(0x2f6) {
            p.wrapping_add(self.rw(0x2fa))
        } else {
            p
        };
        p.wrapping_sub(4)
    }
    /// The left side moves to the next entry: R:000C, its flags in R:0014.
    fn left_on(&mut self) {
        let p = self.forward(self.rw(0x0c));
        self.set(0x0c, p);
        let fl = self.rw(p);
        self.set(0x14, fl);
    }
    /// The right side moves to the entry before: R:0010, its flags in R:0018.
    fn right_on(&mut self) {
        let p = self.backward(self.rw(0x10));
        self.set(0x10, p);
        let fl = self.rw(p);
        self.set(0x18, fl);
    }
    /// A border list that starts at row `y` (no lower than this row: else None): its offset in R.
    fn border(&self, y: u16, list: u16) -> Option<u16> {
        let k = (y as i16).wrapping_sub(self.dx());
        if k > 0 {
            return None;
        }
        Some((k as u16).wrapping_mul(2).wrapping_add(list))
    }

    fn run(&mut self, size: u16) {
        // 09A3: the ring
        self.set(0x63c, size);
        let end = self.rw(0x0c);
        self.set(0x2f8, end);
        let start = self.rw(0x10);
        self.set(0x2f6, start);
        self.set(0x2fa, size);
        let mode = self.rw(0x640) & 0x3f;
        self.set(0x640, mode);
        // the lowest vertex: the entry whose edge starts lowest (09BC..0A21)
        let mut bx;
        if (size as i16) < 8 {
            bx = start;
            self.dx = self.rw(self.rw(start + 2));
        } else {
            let mut di = start;
            self.dx = self.rw(self.rw(di + 2));
            di = di.wrapping_add(4);
            bx = di;
            while self.rw(0x0c) != di {
                let rec = self.rw(di + 2);
                di = di.wrapping_add(4);
                let y0 = self.rw(rec) as i16;
                let take = if mode != 0 {
                    // 09E8: lower, or level with it and flat
                    self.dx() < y0 || (self.dx() == y0 && self.dx() == self.rw(rec + 2) as i16)
                } else {
                    self.dx() < y0 // 0A13
                };
                if take {
                    self.dx = y0 as u16;
                    bx = di;
                }
            }
            bx = bx.wrapping_sub(4);
        }
        self.set_flags(0); // 0A25
        let ok = if mode == 0 {
            self.start_plain(bx)
        } else if self.rw(bx) & 0x40 != 0 {
            self.start_backward(bx)
        } else {
            self.start_forward(bx)
        };
        if !ok {
            return;
        }
        // 0D8D: the colour, the row's address
        let c = self.m.rb(0x2f4) as u16;
        self.set(0x48, c | c << 8);
        let row = self.dx.wrapping_sub(1);
        if row >= 0xa4 {
            return;
        }
        let (es, di) = self.m.far(0x1c);
        self.es = es;
        self.di = di.wrapping_add(0x140u16.wrapping_mul(row));
        if self.dx() > self.ss_w(self.bp.wrapping_add(0x132)) as i16 {
            // 0DBA: the rows through the cockpit's window
            self.bp = 0x6364u16.wrapping_add(row.wrapping_sub(0x67).wrapping_mul(2));
            loop {
                let Some(ax) = self.left_x(Walk::Bordered) else {
                    return;
                };
                let Some(cx) = self.right_x(Walk::Bordered) else {
                    return;
                };
                self.cockpit_span(ax, cx);
                self.bp = self.bp.wrapping_sub(2); // 10AE
                self.dx = self.dx.wrapping_sub(1);
                if self.dx == 0x67 {
                    break;
                }
            }
            self.bp = 0; // 10BE
            self.di = self.di.wrapping_sub(0x140);
            self.open_rows(Walk::Bordered);
        } else if mode != 0 {
            self.open_rows(Walk::Bordered); // 10CD
        } else {
            self.open_rows(Walk::Plain); // 1378
        }
    }

    /// The first edges when the lowest entry runs forward (0A3E): the left side on it, the right
    /// on the one before; a polygon on the screen's edge starts on a border list.
    fn start_forward(&mut self, bx: u16) -> bool {
        self.set(0x0c, bx);
        let fl = self.rw(bx);
        self.set(0x14, fl);
        self.dec_left();
        self.si = self.rw(bx + 2).wrapping_add(8);
        self.set(0x10, bx);
        self.right_on();
        self.bx = self.rw(self.rw(0x10) + 2).wrapping_add(8);
        let (si, bx) = (self.si, self.bx);
        if self.rw(0x14) & 0x10 == 0 {
            return self.same_row_right(); // 0BA2
        }
        if self.rw(si - 8) == 0xa4 {
            // 0B0B
            if self.rw(0x18) & 0x40 != 0 && self.rw(bx - 8) == 0xa4 {
                return self.same_row_right();
            }
            if self.rw(si - 4) != 0x140 && self.rw(0x640) & 4 == 0 {
                return false;
            }
            return self.right_border();
        }
        if self.rw(si - 4) == 0x140 {
            return self.right_border(); // 0B2F
        }
        if self.rw(si - 4) != 0 {
            return false;
        }
        // 0AAC: the left edge on the left border
        let level = if self.rw(0x18) & 0x40 != 0 {
            if self.rw(bx - 4) == 0 {
                Some(self.rw(bx - 8) == self.rw(si - 8))
            } else {
                None
            }
        } else if self.rw(bx - 2) == 0 {
            Some(self.rw(si - 8) == self.rw(bx - 6))
        } else {
            None
        };
        match level {
            Some(true) => return self.same_row_right(),
            Some(false) => return false,
            None => {}
        }
        // 0ADE: from the bottom row, along the left border
        if self.rw(0x640) & 1 == 0 {
            return false;
        }
        self.dx = 0xa4;
        let Some(si) = self.border(self.rw(si - 8), 0x4a8) else {
            return false;
        };
        self.si = si;
        self.set_flags(self.flags() | 0x80);
        self.set(0x63c, self.rw(0x63c).wrapping_add(4));
        self.right_border()
    }

    /// 0B2F: the right side's first edge on the right border, or a border list from the mode.
    fn right_border(&mut self) -> bool {
        let e = self.rw(0x10);
        let rec = self.rw(e + 2);
        let (xf, yf) = if self.rw(e) & 0x40 != 0 {
            (4, 0)
        } else {
            (6, 2)
        };
        let y = if self.rw(rec + xf) == 0x140 {
            self.rw(rec + yf)
        } else if self.rw(0x640) & 2 != 0 {
            0
        } else {
            return false;
        };
        let Some(bx) = self.border(y, 0x63a) else {
            return false;
        };
        self.bx = bx;
        self.set_flags(self.flags() | 0x40);
        true
    }

    /// 0BA2: the right side's edge starts on this row.
    fn same_row_right(&mut self) -> bool {
        if self.dx != self.rw(self.bx - 8) {
            return false;
        }
        self.dec_left();
        true
    }

    /// The first edges when the lowest entry runs backward (0BB3): the right side on it, the left
    /// on the one after.
    fn start_backward(&mut self, bx: u16) -> bool {
        self.set(0x10, bx);
        let fl = self.rw(bx);
        self.set(0x18, fl);
        self.dec_left();
        self.bx = self.rw(bx + 2).wrapping_add(8);
        self.set(0x0c, bx);
        self.left_on();
        self.si = self.rw(self.rw(0x0c) + 2).wrapping_add(8);
        let (si, bx) = (self.si, self.bx);
        if self.rw(0x18) & 0x10 == 0 {
            return self.same_row_left(); // 0D17
        }
        if self.rw(bx - 8) == 0xa4 {
            // 0C80
            if self.rw(0x14) & 0x40 == 0 && self.rw(si - 8) == 0xa4 {
                return self.same_row_left();
            }
            if self.rw(bx - 4) != 0 && self.rw(0x640) & 1 == 0 {
                return false;
            }
            return self.left_border();
        }
        if self.rw(bx - 4) == 0 {
            return self.left_border(); // 0CA4
        }
        if self.rw(bx - 4) != 0x140 {
            return false;
        }
        // 0C21: the right edge on the right border
        let level = if self.rw(0x14) & 0x40 != 0 {
            if self.rw(si - 2) == 0x140 {
                Some(self.rw(bx - 8) == self.rw(si - 6))
            } else {
                None
            }
        } else if self.rw(si - 4) == 0x140 {
            Some(self.rw(bx - 8) == self.rw(si - 8))
        } else {
            None
        };
        match level {
            Some(true) => return self.same_row_left(),
            Some(false) => return false,
            None => {}
        }
        // 0C53: from the bottom row, along the right border
        if self.rw(0x640) & 4 == 0 {
            return false;
        }
        self.dx = 0xa4;
        let Some(bx) = self.border(self.rw(bx - 8), 0x63a) else {
            return false;
        };
        self.bx = bx;
        self.set_flags(self.flags() | 0x40);
        self.set(0x63c, self.rw(0x63c).wrapping_add(4));
        self.left_border()
    }

    /// 0CA4: the left side's first edge on the left border, or a border list from the mode.
    fn left_border(&mut self) -> bool {
        let e = self.rw(0x0c);
        let rec = self.rw(e + 2);
        let (xf, yf) = if self.rw(e) & 0x40 != 0 {
            (6, 2)
        } else {
            (4, 0)
        };
        let y = if self.rw(rec + xf) == 0 {
            self.rw(rec + yf)
        } else if self.rw(0x640) & 8 != 0 {
            0
        } else {
            return false;
        };
        let Some(si) = self.border(y, 0x4a8) else {
            return false;
        };
        self.si = si;
        self.set_flags(self.flags() | 0x80);
        true
    }

    /// 0D17: the left side's edge starts on this row.
    fn same_row_left(&mut self) -> bool {
        if self.dx != self.rw(self.si - 8) {
            return false;
        }
        self.dec_left();
        true
    }

    /// Mode 0's first edges (0D27): the lowest entry and its neighbour, by its direction.
    fn start_plain(&mut self, bx: u16) -> bool {
        if self.rw(bx) & 0x40 == 0 {
            self.set(0x0c, bx);
            let fl = self.rw(bx);
            self.set(0x14, fl);
            self.si = self.rw(bx + 2).wrapping_add(8);
            self.set(0x10, bx);
            self.right_on();
            self.bx = self.rw(self.rw(0x10) + 2).wrapping_add(8);
        } else {
            self.set(0x10, bx);
            let fl = self.rw(bx);
            self.set(0x18, fl);
            self.bx = self.rw(bx + 2).wrapping_add(8);
            self.set(0x0c, bx);
            self.left_on();
            self.si = self.rw(self.rw(0x0c) + 2).wrapping_add(8);
        }
        true
    }

    /// R:063C, the ring's bytes left to walk, less one entry: false when none were left.
    fn dec_left(&mut self) -> bool {
        let n = self.rw(0x63c).wrapping_sub(4);
        self.set(0x63c, n);
        (n as i16) >= 0
    }

    /// The left side's x on this row (DCB, 10EF, 1441; 138F, 173F in mode 0), or None: the
    /// polygon is done.
    fn left_x(&mut self, walk: Walk) -> Option<u16> {
        let mut ax = self.rw(self.si);
        self.si = self.si.wrapping_add(2);
        if (ax as i16) >= 0 {
            return Some(ax);
        }
        if walk == Walk::Plain {
            loop {
                // 1399: the next entry, which must start on this row
                let p = self.forward(self.rw(0x0c));
                if p == self.rw(0x10) {
                    return None;
                }
                self.set(0x0c, p);
                let rec = self.rw(p + 2);
                if self.dx != self.rw(rec) {
                    return None;
                }
                self.si = rec.wrapping_add(10);
                ax = self.rw(rec + 8);
                if (ax as i16) >= 0 {
                    return Some(ax);
                }
            }
        }
        loop {
            // DD8: the edge (or border list) is done
            let fl = self.flags();
            self.set_flags(fl & 0x7f);
            if fl & 0x80 == 0 {
                let e = self.rw(0x14);
                let on_border = if e & 0x40 != 0 {
                    e & 0x10 != 0
                } else {
                    e & 0x20 != 0
                };
                if on_border {
                    // DFA, E0D: an edge ending on the right border ends the polygon
                    let rec = self.rw(self.rw(0x0c) + 2);
                    let xf = if e & 0x40 != 0 { 4 } else { 6 };
                    if self.rw(rec + xf) == 0x140 {
                        return None;
                    }
                    // E29: the next edge, or the left border up to it
                    self.left_on();
                    let p = self.rw(0x0c);
                    let rec = self.rw(p + 2);
                    let (xf, yf) = if self.rw(p) & 0x40 != 0 {
                        (6, 2)
                    } else {
                        (4, 0)
                    };
                    let y = if self.rw(rec + xf) == 0 {
                        self.rw(rec + yf)
                    } else if self.rw(0x640) & 8 != 0 {
                        0
                    } else {
                        return None;
                    };
                    self.si = self.border(y, 0x4a8)?;
                    self.set_flags(self.flags() | 0x80);
                    ax = self.rw(self.si);
                    self.si = self.si.wrapping_add(2);
                    if (ax as i16) >= 0 {
                        return Some(ax);
                    }
                    continue;
                }
                self.left_on(); // EBB
            }
            // ED7: on to the edge R:000C points at, which must start on this row
            if !self.dec_left() {
                return None;
            }
            let rec = self.rw(self.rw(0x0c) + 2);
            self.si = rec.wrapping_add(8);
            if self.dx != self.rw(rec) {
                return None;
            }
            ax = self.rw(self.si);
            self.si = self.si.wrapping_add(2);
            if (ax as i16) >= 0 {
                return Some(ax);
            }
        }
    }

    /// The right side's x on this row (F01, 1225, 1577; 13C9, 177F in mode 0), or None.
    fn right_x(&mut self, walk: Walk) -> Option<u16> {
        let mut cx = self.rw(self.bx);
        self.bx = self.bx.wrapping_add(2);
        if (cx as i16) >= 0 {
            return Some(cx);
        }
        if walk == Walk::Plain {
            loop {
                // 13D4
                let p = self.backward(self.rw(0x10));
                if p == self.rw(0x0c) {
                    return None;
                }
                self.set(0x10, p);
                let rec = self.rw(p + 2);
                if self.dx != self.rw(rec) {
                    return None;
                }
                self.bx = rec.wrapping_add(10);
                cx = self.rw(rec + 8);
                if (cx as i16) >= 0 {
                    return Some(cx);
                }
            }
        }
        loop {
            // F0F
            let fl = self.flags();
            self.set_flags(fl & 0xbf);
            if fl & 0x40 == 0 {
                let e = self.rw(0x18);
                let on_border = if e & 0x40 != 0 {
                    e & 0x20 != 0
                } else {
                    e & 0x10 != 0
                };
                if on_border {
                    // F33, F46: an edge ending on the left border ends the polygon
                    let rec = self.rw(self.rw(0x10) + 2);
                    let xf = if e & 0x40 != 0 { 6 } else { 4 };
                    if self.rw(rec + xf) == 0 {
                        return None;
                    }
                    // F62: the edge before, or the right border up to it
                    self.right_on();
                    let p = self.rw(0x10);
                    let rec = self.rw(p + 2);
                    let (xf, yf) = if self.rw(p) & 0x40 != 0 {
                        (4, 0)
                    } else {
                        (6, 2)
                    };
                    let y = if self.rw(rec + xf) == 0x140 {
                        self.rw(rec + yf)
                    } else if self.rw(0x640) & 2 != 0 {
                        0
                    } else {
                        return None;
                    };
                    self.bx = self.border(y, 0x63a)?;
                    self.set_flags(self.flags() | 0x40);
                    cx = self.rw(self.bx);
                    self.bx = self.bx.wrapping_add(2);
                    if (cx as i16) >= 0 {
                        return Some(cx);
                    }
                    continue;
                }
                self.right_on(); // FF4
            }
            // 1010
            if !self.dec_left() {
                return None;
            }
            let rec = self.rw(self.rw(0x10) + 2);
            self.bx = rec.wrapping_add(8);
            if self.dx != self.rw(rec) {
                return None;
            }
            cx = self.rw(self.bx);
            self.bx = self.bx.wrapping_add(2);
            if (cx as i16) >= 0 {
                return Some(cx);
            }
        }
    }

    /// Store `n` bytes of the colour word R:0048 at ES:(row + x), as STOSB then REP STOSW.
    fn store(&mut self, row: u16, x: u16, n: u16) {
        let [lo, hi] = self.rw(0x48).to_le_bytes();
        let rec = list::recording();
        let mut d = row.wrapping_add(x);
        if n & 1 == 1 {
            self.m.set_b(self.es, d, lo);
            if rec {
                list::fill_px(self.es, d, lo);
            }
            d = d.wrapping_add(1);
        }
        for _ in 0..n / 2 {
            self.m.set_b(self.es, d, lo);
            self.m.set_b(self.es, d.wrapping_add(1), hi);
            if rec {
                list::fill_px(self.es, d, lo);
                list::fill_px(self.es, d.wrapping_add(1), hi);
            }
            d = d.wrapping_add(2);
        }
    }

    /// A row through the cockpit's window (103B): its screen offset (0: hidden), its limits, the
    /// gap between its two openings.
    fn cockpit_span(&mut self, mut ax: u16, mut cx: u16) {
        let t = |s: &Self, o: u16| s.ss_w(s.bp.wrapping_add(o));
        let at = t(self, 0);
        if at == 0 {
            return;
        }
        let (es, di) = self.m.far(0x1c);
        self.es = es;
        self.di = di.wrapping_add(at);
        if (ax as i16) < (t(self, 0x1f2) as i16) {
            ax = t(self, 0x1f2);
        }
        if (cx as i16) > (t(self, 0x298) as i16) {
            cx = t(self, 0x298);
        }
        let (gap0, gap1) = (t(self, 0xa6), t(self, 0x14c));
        if (cx as i16) > (gap0 as i16) && (ax as i16) < (gap1 as i16) {
            if (ax as i16) < (gap0 as i16) {
                // 106F: the left opening, then the right
                let n = gap0.wrapping_sub(ax);
                if (n as i16) > 0 {
                    self.store(self.di, ax, n);
                }
                let (es, di) = self.m.far(0x1c);
                self.es = es;
                self.di = di.wrapping_add(t(self, 0));
            }
            if (cx as i16) <= (gap1 as i16) {
                return; // 1090
            }
            ax = gap1;
        }
        let n = cx.wrapping_sub(ax); // 109A
        if (n as i16) > 0 {
            self.store(self.di, ax, n);
        }
    }

    /// The rows above the cockpit's window, or all rows outside the cockpit (10D8, 1378): flat,
    /// or the crowd.
    fn open_rows(&mut self, walk: Walk) {
        let crowd = self.m.rb(0x48) == 0x1b && {
            if self.m.b(self.m.ss, self.bp.wrapping_add(0x124a)) == 0 {
                self.set(0x48, 0x0a0a); // empty stands
                false
            } else {
                true
            }
        };
        if crowd {
            // 142A, 1728
            self.set(0x2b2, 0);
            self.set(0x2b0, 0);
            let b = self.m.b(self.m.ss, self.bp.wrapping_add(0x185));
            let ss = self.m.ss;
            self.m.set_b(ss, self.bp.wrapping_add(0x186), b << 2);
        }
        loop {
            let Some(ax) = self.left_x(walk) else { return };
            let Some(cx) = self.right_x(walk) else { return };
            let n = cx.wrapping_sub(ax);
            if (n as i16) > 0 {
                if crowd {
                    self.crowd_span(ax, n);
                } else {
                    self.store(self.di, ax, n);
                }
            }
            self.di = self.di.wrapping_sub(0x140);
            self.dx = self.dx.wrapping_sub(1);
            if self.dx == 0 {
                return;
            }
        }
    }

    /// A row of the crowd (16B1): `n` pixels of the strip, from a place that moves on by the row's
    /// step (R:02B4, 64 steps) and by the last row's length.
    fn crowd_span(&mut self, x: u16, n: u16) {
        let k = (self.rw(0x2b2).wrapping_add(1)) & 0x3f;
        self.set(0x2b2, k);
        let mut a =
            (self.m.rb(0x2b4u16.wrapping_add(k)) as u16).wrapping_add(self.rw(0x2b0)) & 0x1ff;
        let ss = self.m.ss;
        let (seg, off) = if (self.m.b(ss, 0x185) as i8) < 0 {
            self.m.far(0x00)
        } else {
            a = a.wrapping_add((self.m.b(ss, 0x186) as u16) << 8);
            self.m.far(0x04)
        };
        let mut s = off.wrapping_add(a);
        let mut d = self.di.wrapping_add(x);
        let rec = list::recording();
        for _ in 0..n {
            let v = self.m.b(seg, s);
            self.m.set_b(self.es, d, v);
            if rec {
                list::fill_px(self.es, d, v);
            }
            s = s.wrapping_add(1);
            d = d.wrapping_add(1);
        }
        self.set(0x2b0, s.wrapping_sub(off));
    }
}
