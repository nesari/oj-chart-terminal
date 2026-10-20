/**
 * Pine instance manager (round 74 — roadmap phases 6+8, renderer side)
 *
 * Owns the per-chart Pine script instances — the same lifecycle the built-in
 * indicators have through indicators-ui:
 *   pane.pineScripts = [{ id, scriptId, inputs, visible }]
 *   RT: pane -> Map(instId -> { adapter, rt, status, errors, errorLine })
 *
 * Data discipline (rounds 70–72): ONE full run over the loaded history on
 * (re)load, then per tick ONLY the forming bar is rolled back and re-run —
 * never a full re-run per tick.
 *
 * request.security_lower_tf is fed OFFLINE from the pane's own symbol: the
 * M1 history the provider already serves is cached per pane and sliced into
 * per-bar intrabar arrays.
 *
 * F4.3: implementation now lives in ./pine-ui/* (inputs, data, panel,
 * templates, runtime); this module only wires it up.
 *
 * @module chart/pine-ui
 */

import { PineUI } from './pine-ui/runtime.js';
import './pine-ui/inputs.js';
import './pine-ui/data.js';
import './pine-ui/panel.js';
import './pine-ui/templates.js';

export { PineUI };
