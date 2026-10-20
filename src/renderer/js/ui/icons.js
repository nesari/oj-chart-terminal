/**
 * SVG icon set (TradingView-style, stroke based)
 *
 * @module ui/icons
 */


const S = (inner, vb) =>
    `<svg viewBox="${vb || '0 0 24 24'}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const F = (inner, vb) =>
    `<svg viewBox="${vb || '0 0 24 24'}" fill="currentColor" stroke="none">${inner}</svg>`;

  const starPath = 'M12 3.4l2.53 5.12 5.65.82-4.09 3.99.97 5.63L12 16.33l-5.06 2.66.97-5.63-4.09-3.99 5.65-.82L12 3.4z';

  const I = {
    /* cursors */
    cross: S('<path d="M12 2.5v6.2M12 15.3v6.2M2.5 12h6.2M15.3 12h6.2"/>'),
    arrowcur: S('<path d="M7 3.5L7 17l3.8-3.4 2.3 5.4 2.4-1-2.3-5.3 5.1-.4z" fill="currentColor" stroke="currentColor" stroke-width="1"/>'),
    dot: S('<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>'),
    /* lines */
    trend: S('<path d="M5.5 18.5L18.5 5.5"/><circle cx="5.5" cy="18.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="18.5" cy="5.5" r="1.7" fill="currentColor" stroke="none"/>'),
    ray: S('<path d="M6 18L20 8"/><circle cx="6" cy="18" r="1.8" fill="currentColor" stroke="none"/><circle cx="20" cy="8" r="1.8"/>'),
    extended: S('<path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.8" fill="currentColor" stroke="none"/><circle cx="20" cy="4" r="1.8" fill="currentColor" stroke="none"/>'),
    parallel: S('<path d="M3.5 19.5l6.5-6.5M14 9.5l6.5-6.5"/><circle cx="3.5" cy="19.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="10" cy="13" r="1.6" fill="currentColor" stroke="none"/><circle cx="14" cy="9.5" r="1.6" fill="currentColor" stroke="none"/>'),
    /* round 52: TV channels flyout additions */
    trendangle: S('<path d="M4 18.5h12.5"/><path d="M16.5 18.5L6.8 8.2"/><path d="M8.3 18.5a8.2 8.2 0 00-2.4-5.8"/>'),
    flattop: S('<path d="M4.5 7.5h15"/><path d="M4.5 16.5l6.2-4.2 4.3 2.9 4.5-3.4"/>'),
    disjoint: S('<path d="M3.5 16.5L11 10M12.5 19.5l8-6.5"/><circle cx="3.5" cy="16.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12.5" cy="19.5" r="1.6" fill="currentColor" stroke="none"/>'),
    arrowline: S('<path d="M5 19L17 7M17 7h-5.5M17 7v5.5"/><circle cx="5" cy="19" r="1.7" fill="currentColor" stroke="none"/>'),
    /* anchors */
    hline: S('<path d="M4 12h16"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/>'),
    hray: S('<path d="M6 12h14"/><circle cx="6" cy="12" r="1.8" fill="currentColor" stroke="none"/>'),
    vline: S('<path d="M12 4v16"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/>'),
    crossline: S('<path d="M12 4v16M4 12h16"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/>'),
    /* shapes */
    rect: S('<rect x="4.5" y="6.5" width="15" height="11" rx="0.5"/>'),
    ellipse: S('<ellipse cx="12" cy="12" rx="8" ry="5.6"/>'),
    triangle: S('<path d="M12 5.2L19.6 18.5H4.4z"/>'),
    /* fibs */
    fib: S('<path d="M4.5 18.5L19.5 5.5"/><path d="M4 17h16M4 12h16M4 8h16M4 5h16"/><circle cx="4.5" cy="18.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="19.5" cy="5.5" r="1.7" fill="currentColor" stroke="none"/>'),
    fibext: S('<path d="M4 19l6.5-6.5 4.5 3.5 5-8"/><path d="M4 8.5h16M4 12.5h16M4 16.5h16"/><circle cx="4" cy="19" r="1.5" fill="currentColor" stroke="none"/><circle cx="10.5" cy="12.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="16" r="1.5" fill="currentColor" stroke="none"/><circle cx="20" cy="8" r="1.5" fill="currentColor" stroke="none"/>'),
    /* annotation */
    text: S('<path d="M5.5 6.5V5h13v1.5M12 5v14M9.5 19h5"/>'),
    note: S('<path d="M7 3.5h10v17l-5-3.6-5 3.6z"/>'),
    /* ROUND248 (TV parity): Icons category button */
    emoji: S('<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/><path d="M8.5 14.5a4.5 4.5 0 007 0"/>'),
    measure: S('<path d="M3.9 15.4L15.4 3.9l4.7 4.7L8.6 20.1z"/><path d="M6.7 12.6l1.5 1.5M9.6 9.7l1.5 1.5M12.5 6.8l1.5 1.5"/>'),
    /* utilities */
    /* ROUND251 (TV parity): Stay-in-drawing-mode glyph — pencil + padlock. */
    stay: S('<path d="M4.5 19.5l1-3.8L15.3 6a2.05 2.05 0 012.9 2.9L8.4 18.6z"/><rect x="14.5" y="14.5" width="6.5" height="5.5" rx="1"/><path d="M16 14.5v-1.2a1.75 1.75 0 013.5 0v1.2"/>'),
    zoomin: S('<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20.5 20.5M11 8.4v5.2M8.4 11h5.2"/>'),
    /* ROUND84 (user request): a proper filled horseshoe magnet — the old thin
       U-outline read as a "U" glyph. Solid body + two pole caps (TV look). */
    magnet: S('<path d="M5.2 3.2h5v8a1.8 1.8 0 003.6 0v-8h5v8a6.8 6.8 0 01-13.6 0V3.2z" fill="currentColor" fill-opacity=".25"/><path d="M5.2 3.2h5v3.6h-5zM13.8 3.2h5v3.6h-5z" fill="currentColor" stroke="none"/>'),
    lock: S('<rect x="6" y="10.5" width="12" height="9" rx="1.5"/><path d="M8.8 10.5V8a3.2 3.2 0 016.4 0v2.5"/>'),
    unlock: S('<rect x="6" y="10.5" width="12" height="9" rx="1.5"/><path d="M8.8 10.5V8a3.2 3.2 0 016.2-1"/>'),
    /* ROUND111: risk-free action on the Open Positions rows (SL → break-even) */
    shield: S('<path d="M12 3l7.2 2.7v5.4c0 4.5-3 7.9-7.2 9.6-4.2-1.7-7.2-5.1-7.2-9.6V5.7z"/><path d="M9.1 12.1l2 2 3.8-4"/>'),
    /* ROUND108: one-click trading — filled bolt for the minimized pill + panel */
    bolt: F('<path d="M13.6 2.2L5.2 13.5h4.9l-1.7 8.3 8.4-11.3h-4.9z"/>'),
    /* ROUND109: one-click position pin (thumbtack) — pin = freeze the widget */
    pin: S('<path d="M12 16.8V21.4"/><path d="M9.2 10.9a2.1 2.1 0 01-1.17 1.88l-1.66.84A2.1 2.1 0 005.2 15.47v.23a1.05 1.05 0 001.05 1.05h11.5a1.05 1.05 0 001.05-1.05v-.23a2.1 2.1 0 00-1.17-1.85l-1.66-.84a2.1 2.1 0 01-1.17-1.88V6.3h.9a2.15 2.15 0 000-4.3H8.3a2.15 2.15 0 000 4.3h.9z"/>'),
    eye: S('<path d="M2.8 12S6.5 5.8 12 5.8 21.2 12 21.2 12 17.5 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.7"/>'),
    eyeoff: S('<path d="M4 4l16 16M9.9 6.3A9.5 9.5 0 0112 5.8c5.5 0 9.2 6.2 9.2 6.2a15.6 15.6 0 01-3.3 3.7M6.3 8.1A15 15 0 002.8 12S6.5 18.2 12 18.2c1.3 0 2.5-.3 3.6-.8"/><path d="M9.9 9.9a2.8 2.8 0 004 4"/>'),
    trash: S('<path d="M4.5 6.5h15M9.5 6.5V4.8h5v1.7M6.5 6.5l1 13h9l1-13M10 10v6M14 10v6"/>'),
    star: F(`<path d="${starPath}"/>`),
    starOutline: S(`<path d="${starPath}"/>`),
    /* top bar */
    search: S('<circle cx="11" cy="11" r="6.4"/><path d="M15.7 15.7L20.5 20.5"/>'),
    clock: S('<circle cx="12" cy="12" r="7.6"/><path d="M12 7.5V12l3 2.4"/>'),
    /* ROUND86: Go to Date (top bar) */
    calendar: S('<rect x="4" y="5.5" width="16" height="14.5" rx="1.5"/><path d="M4 9.5h16M8.5 3.5v4M15.5 3.5v4"/><path d="M8 13h2.5M8 16.5h2.5M13.5 13H16M13.5 16.5H16"/>'),
    candles: S('<path d="M8 3.5V6M8 16v4.5M5.5 6h5v10h-5zM16 3.5V8M16 18v2.5M13.5 8h5v10h-5z"/>'),
    barsstyle: S('<path d="M7 4v16M4.5 7.5H7M7 12h2.5M17 4v16M14.5 9.5H17M17 14.5h2.5"/>'),
    linestyle: S('<path d="M3.5 17.5l5.5-7 4 3.5 7.5-9"/>'),
    area: S('<path d="M3.5 16.5l5.5-6.5 4 3 7.5-8v13.5h-17z" fill="currentColor" fill-opacity=".25"/>'),
    layout1: S('<rect x="4" y="4.5" width="16" height="15" rx="1"/>'),
    layout2v: S('<rect x="4" y="4.5" width="16" height="15" rx="1"/><path d="M12 4.5v15"/>'),
    layout2h: S('<rect x="4" y="4.5" width="16" height="15" rx="1"/><path d="M4 12h16"/>'),
    layout3: S('<rect x="4" y="4.5" width="16" height="15" rx="1"/><path d="M4 12h16M12 12v7.5"/>'),
    layout4: S('<rect x="4" y="4.5" width="16" height="15" rx="1"/><path d="M12 4.5v15M4 12h16"/>'),
    layout6: S('<rect x="4" y="4.5" width="16" height="15" rx="1"/><path d="M12 4.5v15M4 9.5h16M4 14.5h16"/>'),
    layout8: S('<rect x="4" y="4.5" width="16" height="15" rx="1"/><path d="M12 4.5v15M4 8.25h16M4 12h16M4 15.75h16"/>'),
    bell: S('<path d="M12 4a5.5 5.5 0 015.5 5.5v4l2 2.8H4.5l2-2.8v-4A5.5 5.5 0 0112 4zM10 19.3a2.1 2.1 0 004 0"/>'),
    /* ROUND130: speaker + sound waves for the Alerts panel "Sound & repeat" card */
    volume: S('<path d="M4 9.5v5h3.2L12 18.6V5.4L7.2 9.5H4z"/><path d="M15.2 9.4a3.6 3.6 0 010 5.2M17.6 7.2a6.8 6.8 0 010 9.6"/>'),
    /* ROUND132: TV top-bar Replay glyph — two OUTLINED left triangles
       (the double-rewind mark on TradingView's toolbar) */
    replay: S('<path d="M11.7 6.3v11.4L3.6 12z"/><path d="M20.4 6.3v11.4L12.3 12z"/>'),
    doc: S('<path d="M6 3.5h9L18.5 7v13.5H6z"/><path d="M8.5 10h7M8.5 13h7M8.5 16h4.5"/>'),
    list: S('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>'),
    /* bottom bar */
    zoomin2: S('<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20.5 20.5M11 8.4v5.2M8.4 11h5.2"/>'),
    zoomout: S('<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20.5 20.5M8.4 11h5.2"/>'),
    fit: S('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    /* context bar */
    extleft: S('<path d="M10.5 12H20M10.5 12l3.8-3.4M10.5 12l3.8 3.4M5 5.5v13"/>'),
    extright: S('<path d="M13.5 12H4M13.5 12l-3.8-3.4M13.5 12l-3.8 3.4M19 5.5v13"/>'),
    fill: S('<rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor" fill-opacity=".28" stroke="currentColor"/><path d="M5 12h14" stroke-width=".8"/>'),
    clone: S('<rect x="8.5" y="8.5" width="11" height="11" rx="1.5"/><path d="M15.5 8.5v-2a1.5 1.5 0 00-1.5-1.5H6.5A1.5 1.5 0 005 6.5V14a1.5 1.5 0 001.5 1.5h2"/>'),
    gear: S('<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>'),
    plus: S('<path d="M12 5v14M5 12h14"/>'),
    /* ROUND49: (+) price-menu actions (TV) — buy / sell / order ticket */
    dblUp: S('<path d="M6 13.2l6-5.7 6 5.7M6 18l6-5.7 6 5.7"/>'),
    dblDn: S('<path d="M6 5.7l6 5.7 6-5.7M6 10.5l6 5.7 6-5.7"/>'),
    orderDoc: S('<path d="M6.5 3.5h8L18 7v13.5H6.5z"/><path d="M14.5 3.5V7H18M12.2 10.5v5M9.7 13h5"/>'),
    /* ROUND119: the bottom dock was renamed "Tool Box" (user request) —
       a real toolbox: case + carrying handle + front latch */
    toolbox: S('<path d="M4.2 9.2h15.6v10.3H4.2z"/><path d="M9.2 9.2V6.9a2.2 2.2 0 012.2-2.2h1.2a2.2 2.2 0 012.2 2.2v2.3"/><path d="M10.3 12.6h3.4v3h-3.4z"/><path d="M12 9.2v3.4M12 15.6v3.9"/>'),
    minus: S('<path d="M5 12h14"/>'),
    chevdown: S('<path d="M6.5 9.2L12 14.7l5.5-5.5"/>'),
    x: S('<path d="M6 6l12 12M18 6L6 18"/>'),
    play: S('<path d="M8 5.5l10.5 6.5L8 18.5z" fill="currentColor" stroke="none"/>'),
    pause: S('<path d="M8 5.5v13M16 5.5v13"/>'),
    stepback: S('<path d="M6 5.5v13M18.5 5.5L9 12l9.5 6.5z" fill="currentColor" stroke="none"/>'),
    stepfwd: S('<path d="M18 5.5v13M5.5 5.5L15 12l-9.5 6.5z" fill="currentColor" stroke="none"/>'),
    jumpstart: S('<path d="M6 5.5v13M19 5.5L9.5 12 19 18.5z" fill="currentColor" stroke="none"/>'),
    server: S('<rect x="4" y="4.5" width="16" height="6.5" rx="1.5"/><rect x="4" y="13" width="16" height="6.5" rx="1.5"/><circle cx="7.5" cy="7.7" r="1" fill="currentColor" stroke="none"/><circle cx="7.5" cy="16.2" r="1" fill="currentColor" stroke="none"/>'),
    sync: S('<path d="M8.5 6.5h7.5a3.5 3.5 0 013.4 4.3M15.5 17.5H8a3.5 3.5 0 01-3.4-4.3"/><path d="M13.2 3.7l2.8 2.8-2.8 2.8M10.8 20.3L8 17.5l2.8-2.8"/>'),
    checkOn: S('<rect x="4" y="4" width="16" height="16" rx="2.5" fill="currentColor" stroke="none"/><path d="M8.6 12.2l2.4 2.4 4.6-5" stroke="#131722" stroke-width="1.8"/>'),
    checkOff: S('<rect x="4" y="4" width="16" height="16" rx="2.5"/>'),
    mt5: S('<circle cx="12" cy="12" r="8.5"/><path d="M7.5 15.5v-6l2.3 3 2.2-3 2.2 3 2.3-3v6" stroke-width="1.3"/>'),
    /* ROUND122: tab undock/dock (Chrome-style detachable tabs) — a small
       window with an arrow leaving it / entering it */
    undock: S('<rect x="3.5" y="9" width="11.5" height="11.5" rx="1.5"/><path d="M12.5 11.5L20.5 3.5M20.5 3.5h-4.6M20.5 3.5v4.6"/>'),
    dock: S('<rect x="9" y="9" width="11.5" height="11.5" rx="1.5"/><path d="M11.5 12.5L3.5 4.5M3.5 4.5h4.6M3.5 4.5v4.6"/>'),
    /* object tree */
    tree: S('<rect x="3.5" y="4" width="6.5" height="5" rx="1"/><rect x="14" y="4" width="6.5" height="5" rx="1"/><rect x="14" y="15" width="6.5" height="5" rx="1"/><path d="M6.75 9v8.5h7.25M6.75 13.5h4"/>'),
    chevR: S('<path d="M9.5 6.5L15 12l-5.5 5.5"/>'),
    /* chart styles (TV set) */
    hollow: S('<path d="M8 3.5V6M8 16v4.5M5.5 6h5v10h-5zM16 3.5V8M16 18v2.5M13.5 8h5v10h-5z"/><path d="M13.5 8v10" fill="currentColor" stroke="none" opacity=".55"/>'),
    heikin: S('<path d="M7.2 4.5l1-.8M7 5.8h5v8.5H7zM16.8 9.7l1-.8M12 9.7h5v9h-5z"/>'),
    linemarkers: S('<path d="M3.5 17.5l5.5-7 4 3.5 7.5-9"/><circle cx="3.5" cy="17.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="13" cy="14" r="1.5" fill="currentColor" stroke="none"/><circle cx="20.5" cy="5" r="1.5" fill="currentColor" stroke="none"/>'),
    step: S('<path d="M4 19h5v-5h5v-5h5V4"/>'),
    baseline: S('<path d="M3.5 9l5.5 5 4-4.5 7.5 6.5"/><path d="M3.5 13h17" stroke-dasharray="2.5 2.5" opacity=".55"/>'),
    highlow: S('<path d="M7 4v16M4.8 9.5H7M7 14h2.2M17 4v16M14.8 11.5H17M17 8.5h2.2" stroke-width="1.4"/>'),
    renko: S('<path d="M4.5 17.5h4v3h-4zM8.5 14.5h4v3h-4zM12.5 11.5h4v3h-4zM8.5 8.5h4v3h-4z"/>'),
    /* snapshot + misc */
    camera: S('<path d="M4 8.2h3.2L9 5.6h6l1.8 2.6H20v10.6H4z"/><circle cx="12" cy="13.2" r="3.1"/>'),
    info: S('<circle cx="12" cy="12" r="8.2"/><path d="M12 11v5" stroke-width="1.6"/><circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none"/>'),
    /* drawing settings dialog + save layout */
    pencil: S('<path d="M4.6 19.4l1-4L16 5a2.1 2.1 0 013 3L8.6 18.4l-4 1z"/><path d="M14.2 6.8l3 3"/>'),
    dots: S('<circle cx="5.5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.7" fill="currentColor" stroke="none"/>'),
    save: S('<path d="M4.5 4.5h12L20.5 8v11.5h-16z"/><path d="M8 4.5v5h8v-5M8 19.5v-6h8v6"/>'),
    /* ROUND178: download-into-tray (Strategy Tester CSV export) */
    download: S('<path d="M12 4v10.5M12 14.5l-4-4M12 14.5l4-4M5 19.5h14"/>'),
    /* ROUND182: bold filled download (the stroked tray read as a dot at 14px) */
    downloadBold: F('<path d="M12 3l4.6 5.6h-2.9v6.1H10.3V8.6H7.4z"/><path d="M4.5 18.2h15v2.6h-15z"/>'),
    /* ROUND132: TV top-bar Indicators glyph — the rising line over a small
       bar block, exactly like TradingView's toolbar button */
    indicators: S('<path d="M3.5 12.2l4.6-4.9 3.6 3.2 8.8-8"/><path d="M4.3 20.2v-4.1M8.8 20.2v-6.1M13.3 20.2v-3.4" opacity=".9"/><path d="M17.8 20.2h3" opacity=".45"/>'),
    arrows: S('<path d="M6.5 17.5L17.5 6.5"/><circle cx="6.5" cy="17.5" r="1.8" fill="currentColor" stroke="none"/><circle cx="17.5" cy="6.5" r="1.8" fill="currentColor" stroke="none"/>'),
    /* per-chart maximize / restore (multi-chart layouts) */
    maximize: S('<path d="M14.5 3.5h6v6M9.5 20.5h-6v-6M20.5 3.5L13 11M3.5 20.5L11 13"/>'),
    restore: S('<path d="M4 9.5h5.5V4M20 14.5h-5.5V20M9.5 9.5L3.5 3.5M14.5 14.5l6 6"/>'),
    copy: S('<path d="M9 6.5V4.5h11v11h-2M4.5 8.5h11v11h-11z"/>'),
    open: S('<path d="M4.5 6.5h5l2 2.5h8v10.5h-15z"/><path d="M4.5 6.5v13"/>'),
    cloudDl: S('<path d="M7.5 18.5a4.2 4.2 0 01-.7-8.35 5.4 5.4 0 0110.5-1.15A3.75 3.75 0 0117.5 16"/><path d="M12 11.5v9M8.7 17.4l3.3 3.1 3.3-3.1"/>'),
    /* rounds 17-19 additions */
    pitchfork: S('<path d="M5 20L17 8M9.5 20.5L19.5 10.5M4.5 15.5L14.5 5.5"/><circle cx="5" cy="20" r="1.5" fill="currentColor" stroke="none"/>'),
    fibchannel: S('<path d="M4 20L16 8M8 21.5L20 9.5M2.5 17.5L12.5 7.5"/>'),
    fibcircles: S('<circle cx="10.5" cy="13.5" r="3.2"/><circle cx="10.5" cy="13.5" r="7.5"/><circle cx="10.5" cy="13.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.8" cy="8.2" r="1.7" fill="currentColor" stroke="none"/>'),
    gannbox: S('<rect x="4" y="6" width="16" height="12"/><path d="M4 10h16M4 14h16M9.3 6v12M14.6 6v12" opacity=".55"/><path d="M4 18L20 6"/><circle cx="4" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="20" cy="6" r="1.6" fill="currentColor" stroke="none"/>'),
    gannsquare: S('<rect x="4" y="4.5" width="15" height="15"/><path d="M4 9.5h15M4 14.5h15M9 4.5v15M14 4.5v15" opacity=".5"/><path d="M4 4.5l15 15M19 4.5L4 19.5"/><circle cx="4" cy="4.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="19.5" r="1.5" fill="currentColor" stroke="none"/>'),
    gannsquaref: S('<rect x="4" y="4.5" width="15" height="15"/><path d="M4 9.5h15M4 14.5h15M9 4.5v15M14 4.5v15" opacity=".5"/><path d="M4 4.5l15 15"/><rect x="7.2" y="7.7" width="8.6" height="8.6" opacity=".55"/>'),
    gannfan: S('<path d="M4 19.5L20 3.5M4 19.5L20 8M4 19.5L20 12.5M4 19.5L20 17"/><path d="M4 19.5L11 3.5M4 19.5L7.5 6.5" opacity=".55"/>'),
    /* round 58: TV Fibonacci flyout additions */
    fibtz: S('<path d="M5 4v16M9.5 4v16M14 4v16M19 4v16" opacity=".9"/><circle cx="5" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="9.5" cy="4" r="1.5" fill="currentColor" stroke="none"/>'),
    fibspeedfan: S('<path d="M5 19L19 9M5 19L19 5.5M5 19L19 13M5 19L19 17M5 19L14.5 4M5 19L8.5 5.5" opacity=".9"/><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/>'),
    fibttime: S('<path d="M4 4v16M9 4v16M14.5 4v16M19 4v16" opacity=".9"/><path d="M4 17l3.5-5 2.5 2L14.5 8" opacity=".9"/><circle cx="4" cy="17" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="14.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.5" cy="8" r="1.4" fill="currentColor" stroke="none"/>'),
    fibspiral: S('<path d="M12.5 12.2a1.8 1.8 0 11-1.8-1.8 3.6 3.6 0 013.6 3.6 5.4 5.4 0 01-5.4 5.4A7.2 7.2 0 016.7 5.3a9 9 0 018.4 2.2 9 9 0 012.9 8.4"/>'),
    fibarcs: S('<path d="M4.5 19.5a15 15 0 0115-15M4.5 19.5a10 10 0 0110-10M4.5 19.5a5 5 0 015-5"/><circle cx="4.5" cy="19.5" r="1.6" fill="currentColor" stroke="none"/>'),
    fibwedge: S('<path d="M4.5 19.5L19.5 8M4.5 19.5L19.5 15"/><circle cx="4.5" cy="19.5" r="1.6" fill="currentColor" stroke="none"/>'),
    pitchfan: S('<path d="M6 20L18 8M6 20L18 12.5M6 20L18 17"/><circle cx="6" cy="20" r="1.7" fill="currentColor" stroke="none"/>'),
    brush: S('<path d="M5.5 18.5L14 10l3 3-8.5 8.5-3.6 1z"/><path d="M12.5 11.5l4-4 3 3-4 4z" fill="currentColor" fill-opacity=".3"/>'),
    highlighter: S('<path d="M5 15.5l6-8 4.5 3.5-6 8H5z"/><path d="M4 21h16"/>'),
    callout: S('<path d="M4 6.5a2 2 0 012-2h12a2 2 0 012 2v7a2 2 0 01-2 2H10l-4 4v-4H6a2 2 0 01-2-2z"/>'),
    arrowmarku: S('<path d="M12 5l7 8h-4v6h-6v-6H5z" fill="currentColor" stroke="none"/>'),
    arrowmarkd: S('<path d="M12 19l-7-8h4V5h6v6h4z" fill="currentColor" stroke="none"/>'),
    arrowmarkl: S('<path d="M5 12l8-7v4h6v6h-6v4z" fill="currentColor" stroke="none"/>'),
    arrowmarkr: S('<path d="M19 12l-8 7v-4H5V9h6V5z" fill="currentColor" stroke="none"/>'),
    flagmark: S('<path d="M7 21V4"/><path d="M7 5h10l-2.5 3L17 11H7" fill="currentColor" fill-opacity=".25"/>'),
    /* round 69: TV shapes flyout additions (Brushes / Arrows / Shapes) */
    arrowmarker: S('<path d="M4.5 19.5L15 9"/><path d="M19.5 4.5l-2.6 9.2-2.4-4.2-4.2-2.4z" fill="currentColor" stroke="none"/><circle cx="4.5" cy="19.5" r="1.5" fill="currentColor" stroke="none"/>'),
    rotrect: S('<path d="M9.4 3.8l10.8 4.6-4.6 10.8-10.8-4.6z"/>'),
    path: S('<path d="M4 18.5q4.5-11 8.5-5t7.5-7"/><circle cx="4" cy="18.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="13.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="20" cy="6.5" r="1.5" fill="currentColor" stroke="none"/>'),
    polyline: S('<path d="M4 17l5-10 5 7 6-9"/><circle cx="4" cy="17" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="7" r="1.5" fill="currentColor" stroke="none"/><circle cx="14" cy="14" r="1.5" fill="currentColor" stroke="none"/><circle cx="20" cy="5" r="1.5" fill="currentColor" stroke="none"/>'),
    circle: S('<circle cx="12" cy="12" r="7.2"/>'),
    arc: S('<path d="M4 17a8.6 8.6 0 0116 0"/><circle cx="4" cy="17" r="1.6" fill="currentColor" stroke="none"/><circle cx="20" cy="17" r="1.6" fill="currentColor" stroke="none"/>'),
    curve: S('<path d="M4 18Q12 3.5 20 18"/><circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/><circle cx="20" cy="18" r="1.5" fill="currentColor" stroke="none"/>'),
    dblcurve: S('<path d="M3.5 9.5c2.8-6 5.7-6 8.5 0s5.7 6 8.5 0"/>'),
    positionl: S('<rect x="4" y="6" width="10" height="12" rx="1"/><path d="M16.5 18.5v-11M14 10.5l2.5-2.7 2.5 2.7"/>'),
    positions: S('<rect x="4" y="6" width="10" height="12" rx="1"/><path d="M16.5 5.5v11M14 13.5l2.5 2.7 2.5-2.7"/>'),
    infoline: S('<path d="M5 19L14.5 9.5"/><circle cx="5" cy="19" r="1.8" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="5.5" height="4.5"/>'),
    regression: S('<path d="M4.5 17l5.5-5.5h9l-5.5 5.5z"/><circle cx="4.5" cy="17" r="1.6" fill="currentColor" stroke="none"/><circle cx="10" cy="11.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="11.5" r="1.6" fill="currentColor" stroke="none"/>'),
    volprofile: S('<path d="M4 20V9M7.5 20V4M11 20v-9M14.5 20V6M18 20v-6M21 20v-9"/>'),
    elliott: S('<path d="M4 19l4.5-8 4 5L17 7l3 4"/><circle cx="4" cy="19" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.5" cy="11" r="1.3" fill="currentColor" stroke="none"/><circle cx="12.5" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="17" cy="7" r="1.3" fill="currentColor" stroke="none"/><circle cx="20" cy="11" r="1.3" fill="currentColor" stroke="none"/>'),
    /* ROUND253: one glyph per Elliott degree (they all shared 'elliott') —
       impulse 5-wave, corrective ABC, contracting triangle, W-X-Y combo. */
    elliott_i: S('<path d="M3.5 19.5L7 11l3.5 5L14 8l3 4 3.5-5"/><circle cx="3.5" cy="19.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="20.5" cy="7" r="1.3" fill="currentColor" stroke="none"/>'),
    elliott_c: S('<path d="M4 17l5-9 4.5 7L19 9"/><circle cx="4" cy="17" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="9" r="1.4" fill="currentColor" stroke="none"/>'),
    elliott_t: S('<path d="M4 15.5L20 9.5 8 18l9-3.5"/><circle cx="4" cy="15.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="20" cy="9.5" r="1.3" fill="currentColor" stroke="none"/>'),
    elliott_wxy: S('<path d="M3.5 17.5L7 9.5l3.5 8 3.5-8 3.5 6"/><circle cx="3.5" cy="17.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="20.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/>'),
    elliott_wxyxz: S('<path d="M3 17l3-7 3 7 3-7 3 7 3-7 3 7"/><circle cx="3" cy="17" r="1.2" fill="currentColor" stroke="none"/><circle cx="21" cy="17" r="1.2" fill="currentColor" stroke="none"/>'),
    xabcd: S('<path d="M4 18l4-10 4 6 4-8 4 12"/><circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="20" cy="18" r="1.3" fill="currentColor" stroke="none"/>'),
    abcd: S('<path d="M4 18l5-11 5 8 6-9"/><circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="7" r="1.3" fill="currentColor" stroke="none"/><circle cx="14" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="20" cy="6" r="1.3" fill="currentColor" stroke="none"/>'),
    cypher: S('<path d="M4 7l4 11 5-8 3 5 4-10"/><circle cx="4" cy="7" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="20" cy="5" r="1.3" fill="currentColor" stroke="none"/>'),
    trianglepat: S('<path d="M5.5 18L12 6.5 18.5 18z"/><circle cx="5.5" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="6.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="18" r="1.4" fill="currentColor" stroke="none"/>'),
    threedrives: S('<path d="M4 19l3.5-5.5 3 3.5 4-7 3 3.5 3.5-6"/><circle cx="4" cy="19" r="1.3" fill="currentColor" stroke="none"/><circle cx="7.5" cy="13.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="10.5" cy="17" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.5" cy="13.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="21" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>'),
    hs: S('<path d="M4 17l3.5-4 2.5 3 2-9 2 9 2.5-3 3.5 4"/><circle cx="7.5" cy="13" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="7" r="1.3" fill="currentColor" stroke="none"/><circle cx="16.5" cy="13" r="1.3" fill="currentColor" stroke="none"/>'),
    /* round 61: TV Cycles flyout additions + the flyout's toolbar glyph */
    cycliclines: S('<path d="M5 4v16M10 4v16M15 4v16M20 4v16" opacity=".95"/><circle cx="5" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="20" r="1.4" fill="currentColor" stroke="none"/>'),
    timecycles: S('<path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="4" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="4" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="4" r="1.4" fill="currentColor" stroke="none"/>'),
    sineline: S('<path d="M3 12c2.2-6 4.4-6 6.6 0s4.4 6 6.6 0 4.4-6 4.8-1.5"/><circle cx="3" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9.6" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
    patwaves: S('<path d="M3.5 16.5L8 6.5l4 9 4-9 4.5 10"/><circle cx="8" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="15.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="6.5" r="1.3" fill="currentColor" stroke="none"/>'),
    compare: S('<path d="M5 19V9M12 19V5M19 19v-7"/><circle cx="5" cy="6.5" r="1.6"/><circle cx="12" cy="19" r="1.6"/><circle cx="19" cy="9" r="1.6"/>'),
    timesales: S('<rect x="4" y="4.5" width="16" height="15" rx="1.5"/><path d="M4 9h16M4 13.5h16M4 18h16" opacity=".6"/><path d="M10 4.5v15" opacity=".6"/>'),
    chevD: S('<path d="M6.5 9.5L12 15l5.5-5.5"/>'),
    chevL: S('<path d="M14.5 6.5L9 12l5.5 5.5"/>'),
    gotolive: S('<path d="M4 12h12M13 8.5L16.5 12 13 15.5"/><path d="M19.5 5.5v13"/>'),
    locate: S('<circle cx="12" cy="12" r="5.6"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><path d="M12 3v3.2M12 17.8V21M3 12h3.2M17.8 12H21"/>'),
    move: S('<path d="M12 3v18M3 12h18M12 3l-2.6 2.6M12 3l2.6 2.6M12 21l-2.6-2.6M12 21l2.6-2.6M3 12l2.6-2.6M3 12l2.6 2.6M21 12l-2.6-2.6M21 12l-2.6 2.6"/>'),
    sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6M18.8 18.8l-1.6-1.6M6.8 6.8L5.2 5.2"/>'),
    moon: S('<path d="M20 13.6A7.6 7.6 0 0110.4 4 7.6 7.6 0 1020 13.6z"/>'),
    grip: S('<circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.2" fill="currentColor" stroke="none"/>'),
    /* round 21: TV floating-bar grip (2 × 3 dots) + drawing templates grid */
    gripdot: S('<circle cx="9" cy="6" r="1.35" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.35" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.35" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.35" fill="currentColor" stroke="none"/>'),
    tpl: S('<rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/>'),
    /* round 23: Undo / Redo (TV top-bar arrows) */
    undo: S('<path d="M8.5 6.5L4.5 10.5l4 4"/><path d="M4.8 10.5H14a5 5 0 015 5v1.2"/>'),
    redo: S('<path d="M15.5 6.5l4 4-4 4"/><path d="M19.2 10.5H10a5 5 0 00-5 5v1.2"/>'),
    /* round 39: Economic News (right rail) — newspaper */
    /* round 62: TV Forecasting & Measurement flyout — TV-style glyphs */
    forecastg: S('<path d="M8 5v6a4 4 0 008 0V5"/><path d="M6.2 5h3.6M14.2 5h3.6"/><circle cx="6.6" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="17.4" cy="5" r="1" fill="currentColor" stroke="none"/>'),
    posforecast: S('<rect x="4" y="6" width="10" height="12" rx="1" stroke-dasharray="3 2.4"/><path d="M14 12h6.5M17.5 9.5L20.5 12l-3 2.5"/>'),
    barspattern: S('<path d="M8 6v3M8 15v3.5M5.8 9h4.4v6H5.8zM16.5 4v2.5M16.5 17v3.5M14.3 6.5h4.4v10.5h-4.4z"/>'),
    ghostfeed: S('<circle cx="5" cy="13.5" r="1.5" fill="currentColor" stroke="none"/><path d="M9.5 7.5v12M8.4 9.5h2.2v5.5H8.4z"/><path d="M14.5 6v12M13.4 8h2.2v7h-2.2z" opacity=".6"/><path d="M19.5 4.5v10M18.4 6.5h2.2v6h-2.2z" opacity=".35"/>'),
    sector: S('<circle cx="6" cy="5.8" r="1.5" fill="currentColor" stroke="none"/><circle cx="6" cy="18.2" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.2" cy="16.8" r="1.5" fill="currentColor" stroke="none"/><path d="M6 7.3v9.4"/><path d="M7.3 6.1a13.4 13.4 0 0110.8 9.7"/>'),
    avwap: S('<path d="M4 16.5L10 7l3 4.5L18.5 5"/><circle cx="4" cy="16.5" r="1.6" fill="currentColor" stroke="none"/><path d="M16 15.5h4.8M16 18.5h4.8M16 21.5h3.2" opacity=".65"/>'),
    fixedvp: S('<path d="M8.5 5v14"/><circle cx="8.5" cy="19.3" r="1.4" fill="currentColor" stroke="none"/><path d="M8.5 7.5h6.5M8.5 11h9.5M8.5 14.5h5.5M8.5 17.5h3.5"/>'),
    anchoredvp: S('<path d="M8.5 6.8v12.5"/><circle cx="8.5" cy="4.8" r="1.4" fill="currentColor" stroke="none"/><path d="M8.5 8.5h6.5M8.5 12h9.5M8.5 15.5h5.5M8.5 18.5h3.5"/>'),
    pricerange: S('<path d="M12 7v10"/><circle cx="12" cy="5.2" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18.8" r="1.5" fill="currentColor" stroke="none"/><path d="M9.2 5.2h-2M16.8 5.2h-2M9.2 18.8h-2M16.8 18.8h-2"/>'),
    daterange: S('<path d="M7 12h10"/><circle cx="5.2" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.8" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M5.2 9.2v-2M5.2 16.8v-2M18.8 9.2v-2M18.8 16.8v-2"/>'),
    datepricerange: S('<rect x="5" y="5" width="14" height="14" rx="1"/><circle cx="5" cy="19" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="1.3" fill="currentColor" stroke="none"/><path d="M9.5 15V9.7M9.5 9.7l-1.7 2M9.5 9.7l1.7 2"/><path d="M9.5 15h5.3M14.8 15l-2-1.7M14.8 15l-2 1.7"/>'),
    news: S('<rect x="3.5" y="5" width="14.5" height="14" rx="1.5"/><path d="M18 8.5h1.6a1 1 0 011 1V17a2 2 0 01-2 2H5"/><path d="M6.5 8.5h5.5M6.5 11.5h8M6.5 14.5h8M6.5 17.5h4"/>'),
    /* round 74: Pine Editor (top bar) — the official-style braces glyph */
    pine: S('<path d="M9 5c-2 0-3 1-3 3v2c0 1.2-.7 2-2 2 1.3 0 2 .8 2 2v2c0 2 1 3 3 3"/><path d="M15 5c2 0 3 1 3 3v2c0 1.2.7 2 2 2-1.3 0-2 .8-2 2v2c0 2-1 3-3 3"/><path d="M12 9.5v5M10.5 11l1.5-1.5L13.5 11"/>'),
    /* ROUND132: TV top-bar Alert glyph — the alarm clock (bells + legs) */
    alertclock: S('<circle cx="12" cy="13.2" r="7"/><path d="M12 9.9v3.3l2.4 1.7"/><path d="M4.6 5.6L7 3.9M19.4 5.6L17 3.9"/><path d="M6.7 19.6l-.9 1.1M17.3 19.6l.9 1.1" opacity=".8"/>'),
    /* ROUND131 (user request): TradingView-parity right-rail icons */
    /* watchlist — TV's bookmark-ribbon glyph */
    bookmark: S('<path d="M6.8 4.5h10.4a1.1 1.1 0 011.1 1.1v14.2l-6.3-4.4-6.3 4.4V5.6a1.1 1.1 0 011.1-1.1z"/><path d="M8.6 4.5v7.6" opacity=".45"/>'),
    /* trading — professional buy/sell exchange arrows over a price axis */
    exchange: S('<path d="M8.2 19V6.2M8.2 6.2L4.9 9.5M8.2 6.2l3.3 3.3"/><path d="M15.8 5v12.8M15.8 17.8l3.3-3.3M15.8 17.8l-3.3-3.3"/><path d="M4 20.7h16" opacity=".5"/>'),
    /* object tree — clean two-level hierarchy (root -> two nodes) */
    tree2: S('<rect x="8.8" y="3.2" width="6.4" height="5" rx="1.3"/><rect x="3" y="15.8" width="6.4" height="5" rx="1.3"/><rect x="14.6" y="15.8" width="6.4" height="5" rx="1.3"/><path d="M12 8.2v3.2M12 11.4H6.2v4.4M12 11.4h5.8v4.4"/>'),
    /* table view — TV's columns glyph (header strip + body rows) */
    grid: S('<rect x="4" y="4.5" width="16" height="15" rx="1.6"/><path d="M4 9.5h16"/><path d="M10.7 9.5v10M4 14.5h16" opacity=".55"/>'),
  };

  const ICONS = I;
  const icon = function (name) { return I[name] || I.x; };

  /* SVG preview of a tile-based layout (picker icons + toolbar button) */
  const layoutIconSvg = function (l, w, h) {
    w = w || 28; h = h || 24;
    const P = 2.2, G = 1.5;
    const uw = (w - 2 * P - G * (l.C - 1)) / l.C;
    const uh = (h - 2 * P - G * (l.R - 1)) / l.R;
    let out = '';
    for (const t of l.tiles) {
      const x = (P + t[0] * (uw + G)).toFixed(2);
      const y = (P + t[1] * (uh + G)).toFixed(2);
      const ww = (t[2] * uw + (t[2] - 1) * G).toFixed(2);
      const hh = (t[3] * uh + (t[3] - 1) * G).toFixed(2);
      out += `<rect x="${x}" y="${y}" width="${ww}" height="${hh}" rx="1.7"/>`;
    }
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1.1">${out}</svg>`;
  };

export { ICONS, icon, layoutIconSvg };
