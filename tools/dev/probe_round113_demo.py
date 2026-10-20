"""ROUND113 — provider-level check: the demo broker stamps deal reason 4/5
(SL/TP) and sl/tp on deals, and the history op returns them untouched, so
the renderer's History grid can paint the S/L cell red / T.P. cell green."""
import sys, importlib

sys.path.insert(0, 'provider')
demo = importlib.import_module('demo')
DemoBroker = demo.DemoBroker

b = DemoBroker()

def rpc(op, **kw):
    msg = {'op': op}
    msg.update(kw)
    r = b.trade_rpc(msg)
    assert r.get('ok'), 'rpc ' + op + ' failed: ' + str(r)
    return r['data']

# symbol spec + quote baseline
spec = rpc('spec', symbol='XAUUSD')
print('spec ok:', spec['symbol'], 'bid', spec['bid'])

# open a BUY 0.02 with SL below -> then force a tick through the SL
acc0 = rpc('account')
bal0 = acc0['balance']
r = rpc('order_send', symbol='XAUUSD', order_type=0, volume=0.02, price=0.0,
        sl=round(spec['bid'] - 5.0, 2), tp=round(spec['bid'] + 10.0, 2), deviation=20)
print('order sent:', r.get('retcode'), r.get('comment'))

st = rpc('state')
assert len(st['positions']) == 1, 'expected 1 open position'
pos = st['positions'][0]
print('position:', pos['ticket'], pos['type'], pos['volume'], 'sl', pos['sl'], 'tp', pos['tp'])

# force an SL hit: a tick below the SL (buy closes on bid <= sl)
sl_px = pos['sl']
b._trade_on_tick("XAUUSD", sl_px - 1.0, sl_px - 1.0 - 0.3, 1758500000)

st2 = rpc('state')
assert len(st2['positions']) == 0, 'SL should have closed the position, got ' + str(len(st2['positions']))
print('SL closed the position OK')

h = rpc('history', **{'from': 1758000000})
deals = h['deals']
outs = [d for d in deals if d['entry'] == 1]
ins = [d for d in deals if d['entry'] == 0]
assert outs, 'no OUT deals in history'
o = outs[-1]
i = ins[-1]
print('OUT deal:', {k: o[k] for k in ('ticket', 'reason', 'sl', 'tp', 'price', 'profit')})
print('IN  deal:', {k: i[k] for k in ('ticket', 'reason', 'sl', 'tp', 'price')})
assert o['reason'] == 4, 'expected DEAL_REASON_SL=4, got ' + str(o['reason'])
assert abs(o['price'] - sl_px) < 0.51, 'close price should sit at the SL fill'
assert i['sl'] == pos['sl'] and i['tp'] == pos['tp'], 'IN deal must carry the position SL/TP'
assert 'fee' in o and 'magic' in o, 'fee/magic fields present'

# now a TP hit on a SELL to prove reason 5
r2 = rpc('order_send', symbol='XAUUSD', order_type=1, volume=0.02, price=0.0,
         sl=round(spec['ask'] + 6.0, 2), tp=round(spec['ask'] - 4.0, 2), deviation=20)
st3 = rpc('state')
p2 = st3['positions'][0]
tp2 = p2['tp']
b._trade_on_tick("XAUUSD", tp2 - 0.8, tp2 - 0.5, 1758500010)  # sell TP: ask falls to/below tp
st4 = rpc('state')
assert len(st4['positions']) == 0, 'TP should have closed the sell'
h2 = rpc('history', **{'from': 1758000000})
outs2 = [d for d in h2['deals'] if d['entry'] == 1]
o2 = max(outs2, key=lambda d: d['time'])
print('TP OUT deal reason:', o2['reason'], 'price', o2['price'])
assert o2['reason'] == 5, 'expected DEAL_REASON_TP=5, got ' + str(o2['reason'])

print('\nPROVIDER ROUND113 CHECKS: ALL GREEN')
