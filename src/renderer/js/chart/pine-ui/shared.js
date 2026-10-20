/**
 * Pine instance manager — shared state handles.
 *
 * Moved verbatim out of chart/pine-ui.js in F4.3.
 *
 * @module chart/pine-ui/shared
 */
const LWC = window.LightweightCharts;

const RT = new Map(); // pane -> Map(instId -> state)
const _tickAt = new Map(); // pane -> last forming-bar refresh ts
const _tickEvery = 250; // ms — forming-bar re-run cadence per pane

export { LWC, RT, _tickAt, _tickEvery };
