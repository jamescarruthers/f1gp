// Shift the host clock seen by the emulator (Date only), then run route-steps.
// node route-clock.cjs OFFSET_HOURS BUNDLE OUTDIR STEPS
const off = +process.argv[2] * 3600 * 1000;
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + off); else super(...a); }
  static now() { return RealDate.now() + off; }
}
global.Date = FakeDate;
console.log('fake now', new Date().toString());
process.argv.splice(2, 1);
require('./route-steps.cjs');
