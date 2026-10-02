// Preloaded into a server process (node --import) to make its clock disagree with every other process's: Date.now() and new Date() are
// shifted by $SKEW_MS. That is what a page opened on another machine (a forwarded port, a phone) sees: event timestamps from a clock that
// is minutes away from its own.
const RealDate = Date;
const skew = Number(process.env.SKEW_MS || 0);
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() + skew); else super(...args); }
  static now() { return RealDate.now() + skew; }
};
