/**
 * Chart manager: panes, layouts (resizable), data, ticks, legend, countdown, render loop
 *
 * F4.3: the implementation now lives in ./manager/* (data, pane, layout,
 * history, render, shell) and this module only wires it up.
 *
 * @module chart/manager
 */

import { Manager } from './manager/shared.js';
import './manager/data.js';
import './manager/pane.js';
import './manager/layout.js';
import './manager/history.js';
import './manager/render.js';
import './manager/shell.js';

export { Manager };
