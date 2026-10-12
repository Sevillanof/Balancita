import json,time,urllib.request,concurrent.futures as cf
P=["PF_XBTUSD","PF_ETHUSD","PF_SOLUSD","PF_ZECUSD","PF_XRPUSD","PF_NEARUSD","PF_HYPEUSD","PF_ADAUSD"]
now=int(time.time()); days=730
def get(u):
    for a in range(6):
        try: return json.load(urllib.request.urlopen(u,timeout=30))["candles"]
        except Exception: time.sleep(1+a)
    raise SystemExit("fail "+u)
def job(p):
    out={}; c=now-days*86400
    while c<now:
        e=min(c+900*1900,now)
        for k in get(f"https://futures.kraken.com/api/charts/v1/trade/{p}/15m?from={c}&to={e}"): out[k["time"]]=k
        c=e
    json.dump([out[k] for k in sorted(out)],open(f"{p}_15m.json","w")); return p,len(out)
with cf.ThreadPoolExecutor(8) as ex:
    for r in ex.map(job,P): print(r,flush=True)
