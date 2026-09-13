'use strict';

/**
 * Testable clock boundary for G6. Scheduling logic must not read Date.now() directly.
 */

function createClock(nowFn) {
  let fn;
  if (typeof nowFn === 'function') {
    fn = nowFn;
  } else if (nowFn instanceof Date || typeof nowFn === 'string' || typeof nowFn === 'number') {
    const frozen = new Date(nowFn);
    fn = () => new Date(frozen.getTime());
  } else {
    fn = () => new Date();
  }
  return {
    now() {
      return new Date(fn());
    },
  };
}

const systemClock = createClock();

module.exports = {
  createClock,
  systemClock,
};
