/**
 * Chart manager — shared namespace object and chart-library handle.
 *
 * Split out of chart/manager.js in F4.3; the sibling modules attach their
 * functions to this one Manager object (no logic changes).
 *
 * @module chart/manager/shared
 */

const LWC = window.LightweightCharts;
const Manager = {};

export { Manager, LWC };
