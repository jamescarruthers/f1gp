//! Bitmaps drawn larger than their art, smoothed (fine::Art::Smooth): xBR level 2's corner cuts,
//! as the cockpit's filter makes them (spike/lib/pixel-smooth.mjs), with a hard edge, so that each
//! fine pixel is one of the bitmap's own colours or clear. Two kinds of cut xBR makes are left
//! out, where this art is square on purpose (`classify`): the corner of a block with a long
//! straight side (a board, a digit's stroke) stays square, and a stripe one art pixel wide
//! between opaque ones (a tyre's wall) is not bent by the shallow and steep cuts.
//!
//! Each art pixel's four corners are classified once (its 5 x 5 neighbourhood, the lumas from the
//! frame's palette, the see-through cells a colour of their own). A fine pixel then takes the art
//! pixel the game's stepping puts it in (column k between X(k) and X(k+1), row r where the rows'
//! count has whole part r) and its centre's place in that art pixel's box (u across, v down); it
//! takes a neighbour's colour where its centre is beyond a corner's cut line. Along a fine row
//! each cut is an interval at one end of the box, so a row of an art pixel is at most five
//! pieces, found with one division per rule.

use super::list::BitRun;

/// A see-through cell, and a cell no run painted.
pub const CLEAR: u16 = 0x100;
pub const NO_RUN: u16 = u16::MAX;

#[cfg(test)]
thread_local! {
    /// (tests) every other cell taken as cut, by no rule: the smoothed path with nothing cut
    pub static NO_CUTS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn no_cuts() -> bool {
    #[cfg(test)]
    return NO_CUTS.get();
    #[cfg(not(test))]
    false
}

/// The cockpit filter's luma (Rec. 709 weights times 48, of the page's 8-bit colours), in units
/// of 1/53125: white is 48 units. Lumas within 15 units count as alike, an edge needs 0.1 unit
/// more change across it, and a see-through cell is -64.
const UNIT: i32 = 53125;
const EQ: i32 = 15 * UNIT;
const MARGIN: i32 = UNIT / 10 + 1;
const SEE_THROUGH: i32 = -64 * UNIT;

/// The cut lines in a corner's own square (u toward f, v toward h, the corner at (1, 1)):
/// A u + B v > G, times 4. Bit 1: the weaker 45-degree cut (edri), 2: 45 degrees (edr), 4: along
/// h's side (edrL, shallow at the bottom right corner), 8: along f's side (edrU, steep there).
const RULES: [(i32, i32, i32); 4] = [(4, 4, 7), (4, 4, 6), (2, 4, 4), (4, 2, 4)];

/// The frame's colours as the filter weighs them: luma and premultiplied RGBA, by palette index
/// (CLEAR the last).
pub struct Pal {
    lum: Vec<i32>,
    rgba: Vec<[i32; 4]>,
}

impl Pal {
    /// From the game's palette (`List::pal`, 6-bit; a grey ramp where it has no entry).
    pub fn of(pal: &[u8]) -> Pal {
        let mut lum = vec![0; 257];
        let mut rgba = vec![[0; 4]; 257];
        for c in 0..256 {
            let v = |k: usize| {
                let v = pal.get(3 * c + k).copied().unwrap_or(c as u8 >> 2) as i32 & 63;
                v << 2 | v >> 4
            };
            let (r, g, b) = (v(0), v(1), v(2));
            lum[c] = 2126 * r + 7152 * g + 722 * b;
            rgba[c] = [r, g, b, 255];
        }
        lum[CLEAR as usize] = SEE_THROUGH;
        Pal { lum, rgba }
    }
    fn dist(&self, a: u16, b: u16) -> i32 {
        let (p, q) = (self.rgba[a as usize], self.rgba[b as usize]);
        (0..4).map(|k| (p[k] - q[k]).abs()).sum()
    }
}

/// An art pixel's corners (bottom right, top right, top left, bottom left, in the art's own
/// orientation): the cuts that apply and the colour each takes.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Cut {
    pub rules: [u8; 4],
    pub near: [u16; 4],
}

/// A stretch of an art row, columns k0 to k1 less one: cells in one colour painted by one run,
/// without cuts, or one cell with cuts.
#[derive(Clone, Copy, Debug)]
pub struct Seg {
    pub k0: i32,
    pub k1: i32,
    pub colour: u16,
    pub run: u16,
    pub cut: Option<Cut>,
}

/// A bitmap's art for smoothing: its columns k0 to k0 + cols less one, and each row's stretches
/// (the bottom row first).
pub struct ArtGrid {
    pub k0: i32,
    pub cols: i32,
    pub rows: Vec<Vec<Seg>>,
}

impl ArtGrid {
    /// The art of `rows` (bottom row first) in the bitmap's colours, classified; None if it has
    /// no corner to cut.
    pub fn new(rows: &[Vec<BitRun>], colours: &[u8; 16], pal: &Pal) -> Option<ArtGrid> {
        Self::classified(rows, colours, pal, true)
    }

    /// As `new`, with or without the cuts xBR makes that we leave out (`classify`).
    fn classified(
        rows: &[Vec<BitRun>],
        colours: &[u8; 16],
        pal: &Pal,
        ours: bool,
    ) -> Option<ArtGrid> {
        // the art's columns: each run from its start (or where the last ended) to its end less one;
        // none (the drawer's pixels) if a row starts without a start, or a run goes back over the
        // last or ends before it starts: what the drawer paints there is not one run to a cell
        // (the art has none of these)
        let (mut lo, mut hi) = (i32::MAX, i32::MIN);
        for runs in rows {
            let mut last = 0i32;
            for (i, q) in runs.iter().enumerate() {
                let s = q.start.map_or(last, |k| k as i32);
                let e = q.end as i32;
                if (i == 0 && q.start.is_none()) || (i > 0 && s < last) || e < s {
                    return None;
                }
                if e > s {
                    lo = lo.min(s);
                    hi = hi.max(e - 1);
                }
                last = e;
            }
        }
        if lo > hi {
            return None;
        }
        // the cells, the top row first, two clear cells round
        let (cols, n) = (hi - lo + 1, rows.len());
        let stride = cols as usize + 4;
        let at = |k: i32, r: usize| (n - 1 - r + 2) * stride + (k - lo + 2) as usize;
        let mut cell = vec![CLEAR; stride * (n + 4)];
        let mut run = vec![NO_RUN; cell.len()];
        for (r, runs) in rows.iter().enumerate() {
            let mut last = 0i32;
            for (i, q) in runs.iter().enumerate() {
                let s = q.start.map_or(last, |k| k as i32);
                for k in s..q.end as i32 {
                    cell[at(k, r)] = colours[q.colour as usize] as u16;
                    run[at(k, r)] = i as u16;
                }
                last = q.end as i32;
            }
        }
        let lum: Vec<i32> = cell.iter().map(|&c| pal.lum[c as usize]).collect();
        // the cells one wide between opaque cells unlike them, across or down (a stripe, a dot)
        let mut thin = vec![false; cell.len()];
        for (a, t) in thin
            .iter_mut()
            .enumerate()
            .take(cell.len() - stride)
            .skip(stride)
        {
            let between = |p: usize, q: usize| {
                let (l, x, y) = (lum[a], lum[p], lum[q]);
                x != l && y != l && x != SEE_THROUGH && y != SEE_THROUGH
            };
            *t = ours && (between(a - 1, a + 1) || between(a - stride, a + stride));
        }
        let offs = offsets(stride);
        let none = no_cuts();
        let mut any = none;
        let mut out = Vec::with_capacity(n);
        for r in 0..n {
            let mut segs: Vec<Seg> = Vec::new();
            for k in lo..=hi {
                let a = at(k, r);
                let (colour, q) = (cell[a], run[a]);
                let mut cut = classify(&cell, &lum, &thin, &offs, stride, a, ours);
                if none {
                    cut.rules = [0; 4];
                }
                if cut.rules != [0; 4] || (none && (k as usize ^ r) & 1 == 0) {
                    any = true;
                    segs.push(Seg {
                        k0: k,
                        k1: k + 1,
                        colour,
                        run: q,
                        cut: Some(cut),
                    });
                    continue;
                }
                if colour == CLEAR {
                    continue;
                }
                match segs.last_mut() {
                    Some(s) if s.cut.is_none() && s.k1 == k && s.colour == colour && s.run == q => {
                        s.k1 = k + 1
                    }
                    _ => segs.push(Seg {
                        k0: k,
                        k1: k + 1,
                        colour,
                        run: q,
                        cut: None,
                    }),
                }
            }
            segs.shrink_to_fit();
            out.push(segs);
        }
        any.then_some(ArtGrid {
            k0: lo,
            cols,
            rows: out,
        })
    }

    /// The bytes it holds, by its vectors' capacities (not the allocator's own).
    pub fn bytes(&self) -> usize {
        self.rows
            .iter()
            .map(|r| r.capacity() * std::mem::size_of::<Seg>() + std::mem::size_of::<Vec<Seg>>())
            .sum()
    }
}

/// (dx, dy) turned a quarter, c times: the bottom right corner's neighbourhood made corner c's.
fn turn(c: usize, (mut x, mut y): (i32, i32)) -> (i32, i32) {
    for _ in 0..c {
        (x, y) = (y, -x);
    }
    (x, y)
}

/// Corner by corner, the offsets in the grid of f, h, b, d, i, c, g, i4, i5, h5, f4 (the bottom
/// right corner's names, pixel-smooth.mjs), a (across E from i), and the cells two on from E
/// along its sides away from the corner: b2 (beyond b) and c2 (beside it, toward f), d2 (beyond
/// d) and g2 (beside it, toward h).
fn offsets(stride: usize) -> [[isize; 16]; 4] {
    const AT: [(i32, i32); 16] = [
        (1, 0),
        (0, 1),
        (0, -1),
        (-1, 0),
        (1, 1),
        (1, -1),
        (-1, 1),
        (2, 1),
        (1, 2),
        (0, 2),
        (2, 0),
        (-1, -1),
        (0, -2),
        (1, -2),
        (-2, 0),
        (-2, 1),
    ];
    let mut o = [[0isize; 16]; 4];
    for (c, oc) in o.iter_mut().enumerate() {
        for (k, &d) in AT.iter().enumerate() {
            let (x, y) = turn(c, d);
            oc[k] = y as isize * stride as isize + x as isize;
        }
    }
    o
}

/// xBR level 2 at the cell `at`'s four corners (pixel-smooth.mjs, corner by corner), from the
/// cells' lumas; if `ours`, less two kinds of cut xBR makes on this art: none at the corner of a
/// block with a long straight side, and no shallow or steep cut that would bend a stripe one
/// cell wide (`thin`).
fn classify(
    cell: &[u16],
    lum: &[i32],
    thin: &[bool],
    offs: &[[isize; 16]; 4],
    stride: usize,
    at: usize,
    ours: bool,
) -> Cut {
    let mut cut = Cut::default();
    let le = lum[at];
    // a cell like its four neighbours has no corner to cut
    if lum[at - 1] == le && lum[at + 1] == le && lum[at - stride] == le && lum[at + stride] == le {
        return cut;
    }
    for (c, o) in offs.iter().enumerate() {
        let l = |k: usize| lum[(at as isize + o[k]) as usize];
        let (lf, lh) = (l(0), l(1));
        // irlv0: E differs from both neighbours at the corner
        if lf == le || lh == le {
            continue;
        }
        let (lb, ld, li, lc, lg) = (l(2), l(3), l(4), l(5), l(6));
        let (li4, li5, lh5, lf4, la) = (l(7), l(8), l(9), l(10), l(11));
        // (ours) the corner of a block at least 2 x 2 (E, b, d and a alike) whose sides are
        // straight for two cells (c and g not like E), one of them for three (b2 like E and c2
        // not, or d2 and g2): a board's corner, a stroke's end, drawn square, so left square.
        // On the art's outline (f and h clear), not if a side steps out after two (b2 and c2
        // like E, or d2 and g2): a wheel's last step onto its flat bottom is cut, as the steps
        // two by two are
        let (lb2, lc2, ld2, lg2) = (l(12), l(13), l(14), l(15));
        let outline = lf == SEE_THROUGH && lh == SEE_THROUGH;
        if ours
            && ld == le
            && lb == le
            && la == le
            && lc != le
            && lg != le
            && ((lb2 == le && lc2 != le) || (ld2 == le && lg2 != le))
            && !(outline && ((lb2 == le && lc2 == le) || (ld2 == le && lg2 == le)))
        {
            continue;
        }
        let df = |a: i32, b: i32| (a - b).abs();
        let eq = |a: i32, b: i32| df(a, b) <= EQ;
        let irlv1 = (!eq(lf, lb) && !eq(lh, ld))
            || (eq(le, li) && !eq(lf, li4) && !eq(lh, li5))
            || eq(le, lg)
            || eq(le, lc);
        let irlv2l = le != lg && ld != lg;
        let irlv2u = le != lc && lb != lc;
        let wd1 = df(le, lc) + df(le, lg) + df(li, lh5) + df(li, lf4) + 4 * df(lh, lf);
        let wd2 = df(lh, ld) + df(lh, li5) + df(lf, li4) + df(lf, lb) + 4 * df(le, li);
        let edri = wd1 <= wd2;
        let edr = wd2 >= wd1 + MARGIN && irlv1;
        // the colour the cut gives E: of f or h, the nearer E's
        let (fa, ha) = ((at as isize + o[0]) as usize, (at as isize + o[1]) as usize);
        let to_f = df(le, lf) <= df(le, lh);
        let ln = if to_f { lf } else { lh };
        // (ours) the shallow and steep cuts move an edge along two cells: not where they would
        // bend a stripe one cell wide between opaque cells, E itself or f or h when the cut gives
        // E its colour (45 degrees may cut)
        let bends = thin[at] || (thin[fa] && ln == lf) || (thin[ha] && ln == lh);
        let edrl = edr && irlv2l && df(lh, lc) >= 2 * df(lf, lg) && !bends;
        let edru = edr && irlv2u && df(lf, lg) >= 2 * df(lh, lc) && !bends;
        cut.rules[c] = edri as u8 | (edr as u8) << 1 | (edrl as u8) << 2 | (edru as u8) << 3;
        cut.near[c] = if to_f { cell[fa] } else { cell[ha] };
    }
    cut
}

/// The first x (0 to w) whose term is beyond the line: c (2x + 1) n + p q > g t, i.e. the
/// smallest x with 2 c n x > g t - p q - c n.
fn beyond(c: i32, p: i32, q: i32, g: i32, t: i32, n: i32, w: i32) -> i32 {
    let num = g * t - p * q - c * n;
    let den = 2 * c * n;
    (num.div_euclid(den) + 1).clamp(0, w)
}

/// Corner by corner, the cut's reach along fine row j (from the top, of n) of a box w fine pixels
/// wide, in x from the art pixel's left (art-wise): the bottom right and top right from their
/// start to w, the top left and bottom left from 0 to their end.
fn reach(cut: &Cut, w: i32, j: i32, n: i32) -> [i32; 4] {
    let t = 2 * w * n;
    // v and 1 - v, times 2wn
    let v = (2 * j + 1) * w;
    let vb = (2 * (n - 1 - j) + 1) * w;
    let mut out = [w, w, 0, 0];
    for (c, (o, &rules)) in out.iter_mut().zip(&cut.rules).enumerate() {
        if rules == 0 {
            continue;
        }
        let mut first = w;
        for (k, &(a, b, g)) in RULES.iter().enumerate() {
            if rules & 1 << k == 0 {
                continue;
            }
            // corner c's own (u, v): BR (u, v), TR (1 - v, u), TL (1 - u, 1 - v), BL (v, 1 - u)
            let x = match c {
                0 => beyond(a, b, v, g, t, n, w),
                1 => beyond(b, a, vb, g, t, n, w),
                2 => beyond(a, b, vb, g, t, n, w),
                _ => beyond(b, a, v, g, t, n, w),
            };
            first = first.min(x);
        }
        *o = if c < 2 { first } else { w - first };
    }
    out
}

/// The colour of a fine pixel of the art pixel (e, cut) that the corners `cover` cover: the top
/// left over the bottom right, the bottom left over the top right, and of the two the one
/// further from E (pixel-smooth.mjs's r1, r2).
fn pick(e: u16, cut: &Cut, cover: [bool; 4], pal: &Pal) -> u16 {
    let r1 = if cover[2] {
        cut.near[2]
    } else if cover[0] {
        cut.near[0]
    } else {
        e
    };
    let r2 = if cover[3] {
        cut.near[3]
    } else if cover[1] {
        cut.near[1]
    } else {
        e
    };
    if r1 == r2 || pal.dist(e, r1) >= pal.dist(e, r2) {
        r1
    } else {
        r2
    }
}

/// The definition: one fine pixel's colour, at x across (of w) and j down (of n), each line
/// tested at the pixel's centre (`pieces` gives the same a row at a time).
#[cfg(test)]
fn pixel(e: u16, cut: &Cut, x: i32, w: i32, j: i32, n: i32, pal: &Pal) -> u16 {
    let t = 2 * w * n;
    let u = (2 * x + 1) * n;
    let ub = (2 * (w - 1 - x) + 1) * n;
    let v = (2 * j + 1) * w;
    let vb = (2 * (n - 1 - j) + 1) * w;
    let mut cover = [false; 4];
    for (c, (cv, &rules)) in cover.iter_mut().zip(&cut.rules).enumerate() {
        let (ul, vl) = match c {
            0 => (u, v),
            1 => (vb, u),
            2 => (ub, vb),
            _ => (v, ub),
        };
        for (k, &(a, b, g)) in RULES.iter().enumerate() {
            if rules & 1 << k != 0 && a * ul + b * vl > g * t {
                *cv = true;
            }
        }
    }
    pick(e, cut, cover, pal)
}

/// Fine row j (from the top, of n) of an art pixel with cuts, w fine pixels wide, as pieces
/// (x0, x1, colour) from its left (art-wise), at most five; their count.
pub fn pieces(
    e: u16,
    cut: &Cut,
    w: i32,
    j: i32,
    n: i32,
    pal: &Pal,
    out: &mut [(i32, i32, u16); 5],
) -> usize {
    let [br, tr, tl, bl] = reach(cut, w, j, n);
    let mut at = [0, tl, bl, tr, br, w];
    at.sort_unstable();
    let mut m = 0;
    for p in 0..5 {
        let (a, b) = (at[p], at[p + 1]);
        if a >= b {
            continue;
        }
        let colour = pick(e, cut, [a >= br, a >= tr, a < tl, a < bl], pal);
        if m > 0 && out[m - 1].2 == colour && out[m - 1].1 == a {
            out[m - 1].1 = b;
        } else {
            out[m] = (a, b, colour);
            m += 1;
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row's pieces are the definition's pixels, for every box up to 24 x 24 and any rules at
    /// every corner (with other colours at each corner, clear among them).
    #[test]
    fn pieces_are_pixels() {
        let pal = Pal::of(&[]);
        let mut seed = 1u32;
        let mut rnd = |n: u32| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) % n
        };
        for trial in 0..20000 {
            let cut = Cut {
                rules: [0, 1, 2, 3].map(|_| rnd(16) as u8),
                near: [0, 1, 2, 3].map(|_| if rnd(5) == 0 { CLEAR } else { rnd(256) as u16 }),
            };
            let e = if trial % 7 == 0 {
                CLEAR
            } else {
                rnd(256) as u16
            };
            let (w, n) = (1 + rnd(24) as i32, 1 + rnd(24) as i32);
            let mut out = [(0, 0, 0u16); 5];
            for j in 0..n {
                let m = pieces(e, &cut, w, j, n, &pal, &mut out);
                let mut x = 0;
                for &(a, b, c) in &out[..m] {
                    assert_eq!(a, x);
                    for xx in a..b {
                        assert_eq!(
                            c,
                            pixel(e, &cut, xx, w, j, n, &pal),
                            "{cut:?} e {e} w {w} n {n} j {j} x {xx}"
                        );
                    }
                    x = b;
                }
                assert_eq!(x, w);
            }
        }
    }

    /// Art from text, the top row first: '.' clear, else a colour (`GREY`, by hex digit);
    /// classified, as we do (`ours`) or as xBR does.
    fn art(text: &[&str], ours: bool) -> Option<ArtGrid> {
        let rows: Vec<Vec<BitRun>> = text
            .iter()
            .rev()
            .map(|line| {
                let mut runs = Vec::new();
                for (k, ch) in line.chars().enumerate() {
                    if let Some(c) = ch.to_digit(16) {
                        runs.push(BitRun {
                            start: Some(k as i8),
                            end: k as i8 + 1,
                            colour: c as u8,
                        });
                    }
                }
                runs
            })
            .collect();
        let colours = std::array::from_fn(|c| c as u8);
        // greys (of 63): 0 a tyre's black, a its wall's grey (alike, to xBR's eye), 1 white, 2
        // and 3 between
        const GREY: [u8; 16] = [7, 63, 32, 48, 0, 0, 0, 0, 0, 0, 19, 0, 0, 0, 0, 0];
        let pal: Vec<u8> = GREY.iter().flat_map(|&v| [v; 3]).collect();
        ArtGrid::classified(&rows, &colours, &Pal::of(&pal), ours)
    }

    /// The rules at the corners of the cell at column k of row `row` from the top (of n).
    fn rules(g: &Option<ArtGrid>, n: usize, k: i32, row: usize) -> [u8; 4] {
        let Some(g) = g else { return [0; 4] };
        g.rows[n - 1 - row]
            .iter()
            .find(|s| (s.k0..s.k1).contains(&k))
            .and_then(|s| s.cut)
            .map_or([0; 4], |c| c.rules)
    }

    /// What we leave out of xBR's cuts. The corners of a block of one colour with a side three
    /// long stay square, on clear and on another colour, and so do the ends of a stroke two
    /// wide (xBR rounds them); the steps of a wheel's outline, two by two and two high onto its
    /// flat bottom, are cut as xBR cuts them, but not the same step inside a board. A stripe one
    /// cell wide between opaque cells is not bent by the shallow or steep cuts: the notch in a
    /// tyre's wall (the cockpit frame ck0301, the tyre of the car ahead) and the S in the wall of
    /// the own car's front tyre (monza 0037); the outline beside a stripe's cell is. Staircases
    /// of single steps and of steps two long are cut as xBR cuts them.
    #[test]
    fn guard() {
        for text in [
            &[".....", ".111.", ".111.", ".111.", "....."][..],
            &[
                "2222222", "2222222", "2211122", "2211122", "2211122", "2222222", "2222222",
            ][..],
            &[".......", ".11111.", ".11111.", "......."][..],
        ] {
            assert!(art(text, false).is_some(), "xBR cuts {text:?}");
            assert!(art(text, true).is_none(), "{text:?} cut");
        }
        // (column, row from the top, corner): xBR's steep cut there, ours at 45 degrees only
        let wall = [
            "0000...", "00000a.", "0000aaa", "0000aaa", "0000aaa", "0000a0a", "0000a00", "0000a00",
            "0000a00", "000aa00", "000aa00", "0000a00", "0000000",
        ];
        let front = [
            "0000.", "000a.", "000aa", "000aa", "000aa", "000aa", "000a0", "000a0", "000a0",
            "000a0", "000a0", "000a0", "000a0", "000a0", "00000",
        ];
        for (text, at) in [
            (&wall[..], &[(5, 5, 2), (3, 8, 0), (4, 11, 0)][..]),
            (&front[..], &[(4, 6, 2)][..]),
        ] {
            let n = text.len();
            let (xbr, ours) = (art(text, false), art(text, true));
            for &(k, row, c) in at {
                assert_eq!(rules(&xbr, n, k, row)[c] & 12, 8, "{text:?} at {k}, {row}");
                assert_eq!(rules(&ours, n, k, row)[c], 3, "{text:?} at {k}, {row}");
            }
        }
        // the bottom left of the car ahead's rear wheel (arts e979d792 and one nearer): its steps
        // two by two cut at their corners, and the last step, two high on the tyre's flat
        // bottom
        let wheel = [
            ".000000000",
            ".000000000",
            "..00000000",
            "..00000000",
            "....000000",
            "....000000",
            "......0000",
            "......0000",
            "......0000",
            "......0000",
        ];
        let last = [
            ".000000000000",
            ".000000000000",
            "..00000000000",
            "....000000000",
            "....000000000",
        ];
        for (text, at) in [
            (&wheel[..], &[(2, 3, 3), (4, 5, 3)][..]),
            (&last[..], &[(4, 4, 3)][..]),
        ] {
            let (xbr, ours) = (art(text, false), art(text, true));
            for &(k, row, c) in at {
                let r = rules(&ours, text.len(), k, row)[c];
                assert_ne!(r, 0, "{text:?} at {k}, {row}, corner {c}");
                assert_eq!(
                    r,
                    rules(&xbr, text.len(), k, row)[c],
                    "{text:?} at {k}, {row}"
                );
            }
        }
        // the same step on a board (a digit's hook below its bar, black on white) left square
        let mut hook: Vec<String> = last.iter().map(|r| r.replace('.', "1")).collect();
        hook.push("1".repeat(13));
        let hook: Vec<&str> = hook.iter().map(|r| r.as_str()).collect();
        let (xbr, ours) = (art(&hook, false), art(&hook, true));
        assert_ne!(rules(&xbr, hook.len(), 4, 4)[3], 0);
        assert_eq!(rules(&ours, hook.len(), 4, 4)[3], 0);
        // a grey cell of a tyre's highlight in the column of its black outline: the clear cell
        // beside it takes the outline's shallow or steep cut, black, which leaves the grey as it is
        let outline = ["...000", "...000", "...a00", "..0000", "..0000", "..0000"];
        let (xbr, ours) = (art(&outline, false), art(&outline, true));
        let r = rules(&ours, outline.len(), 2, 2)[0];
        assert_ne!(r & 12, 0, "{outline:?}");
        assert_eq!(r, rules(&xbr, outline.len(), 2, 2)[0], "{outline:?}");
        // single steps, on clear and on another colour: the top right corner of each row's last
        // cell and the bottom left of the next cut at 45 degrees
        for text in [
            ["1.....", "11....", "111...", "1111..", "11111.", "111111"],
            ["211111", "221111", "222111", "222211", "222221", "222222"],
        ] {
            let g = art(&text, true);
            for r in 1..5 {
                assert_ne!(rules(&g, 6, r as i32, r)[1] & 2, 0, "{text:?} step {r}");
                assert_ne!(rules(&g, 6, r as i32 + 1, r)[3] & 2, 0, "{text:?} step {r}");
            }
        }
        // steps two long: the shallow cut (in the top right corner's own square, along f)
        let text = [
            "11..........",
            "1111........",
            "111111......",
            "11111111....",
            "1111111111..",
            "111111111111",
        ];
        let g = art(&text, true);
        for r in 0..5 {
            assert_ne!(rules(&g, 6, 2 * r as i32 + 1, r)[1] & 8, 0, "step {r}");
            assert_ne!(rules(&g, 6, 2 * r as i32 + 2, r)[3] & 8, 0, "step {r}");
        }
    }
}
