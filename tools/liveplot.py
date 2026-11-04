#!/usr/bin/env python3
"""Live heat graph, fed by whatever tool is holding the BLE link.

A Peak accepts one connection, so the graph cannot be its own client. Instead a
running harness calls `LivePlot.publish(...)` and this serves a page that polls
the same process. Nothing here talks to the device.

    from liveplot import LivePlot
    live = LivePlot().start()          # prints the URL
    live.publish(t, target_f, chamber_f, tcmd_f, duty, soc, state)

Open the printed URL and watch. Ctrl-C the tool and the page says so.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8792
KEEP = 1200            # ~10 min at 2 Hz before the oldest sample is dropped

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Peak</title>
<style>
 html,body{margin:0;height:100%;background:#0d0f14;color:#eef1f7;
   font-family:ui-sans-serif,system-ui,sans-serif}
 body{display:flex;flex-direction:column;align-items:center;justify-content:center;
   gap:10px;text-align:center;padding:20px;box-sizing:border-box}
 #word{font-size:clamp(44px,13vw,120px);font-weight:800;letter-spacing:.02em;
   line-height:1;margin:0}
 #word.good{color:#5ddb8b} #word.warn{color:#e8bd4e} #word.bad{color:#f4735f}
 #word.idle{color:#7d879b}
 #say{font-size:clamp(15px,2.6vw,21px);max-width:34ch;margin:0;color:#b9c2d4}
 #spark{width:min(640px,92vw);height:90px;opacity:.85}
 #meta{margin-top:6px;font:12px ui-monospace,monospace;color:#68718a}
 #more{display:none;width:min(860px,94vw);margin-top:14px}
 #more.on{display:block}
 #more canvas{width:100%;height:180px;display:block}
 #more .lg{font:11px ui-monospace,monospace;color:#68718a;margin-top:6px}
 .k{display:inline-block;width:8px;height:8px;border-radius:2px;margin:0 4px 0 10px}
 a{color:#68718a;font:12px ui-monospace,monospace;cursor:pointer;text-decoration:none}
 a:hover{color:#b9c2d4}
</style></head><body>
<p id="word" class="idle">WAITING</p>
<p id="say">Start a test below. This page will tell you how it is going.</p>
<canvas id="spark" width="640" height="90"></canvas>
<div id="meta"><span id="soc"></span> <a id="toggle">details</a></div>
<div id="more"><canvas id="det" width="860" height="180"></canvas>
 <div class="lg"><span class="k" style="background:#e2603f"></span>heat
 <span class="k" style="background:#c9a227"></span>coil
 <span class="k" style="background:#8b93a7"></span>asked for</div></div>
<script>
const W=document.getElementById('word'), S=document.getElementById('say');
const M=document.getElementById('meta');
let series=[];
document.getElementById('toggle').onclick=()=>{
  const m=document.getElementById('more'); m.classList.toggle('on');
  document.getElementById('toggle').textContent = m.classList.contains('on')?'hide':'details';
};
function line(cv,keys,lo,hi){
  const c=document.getElementById(cv), x=c.getContext('2d');
  const r=devicePixelRatio||1; c.width=c.clientWidth*r; c.height=c.clientHeight*r;
  x.setTransform(r,0,0,r,0,0); const w=c.clientWidth,h=c.clientHeight;
  x.clearRect(0,0,w,h);
  if(series.length<2)return;
  const t0=series[0].t, span=Math.max(series[series.length-1].t-t0,1);
  for(const [k,col] of keys){
    x.strokeStyle=col; x.lineWidth=k==='chamber'?2.4:1.3; x.beginPath();
    let on=false;
    for(const s of series){
      const v=s[k]; if(v==null)continue;
      const px=(s.t-t0)/span*w, py=h-(v-lo)/(hi-lo)*h;
      on?x.lineTo(px,py):(x.moveTo(px,py),on=true);
    }
    x.stroke();
  }
}
function range(pad){
  let lo=Infinity,hi=-Infinity;
  for(const s of series)for(const k of ['chamber','tcmd','target']){
    const v=s[k]; if(v==null)continue; lo=Math.min(lo,v); hi=Math.max(hi,v);}
  if(!isFinite(lo)){lo=450;hi=550;}
  const d=(hi-lo)*pad||8; return [lo-d,hi+d];
}
function say(word,cls,text){
  W.textContent=word; W.className=cls; S.textContent=text;
}
function judge(){
  if(!series.length){say('WAITING','idle','Start a test below. This page will tell you how it is going.');return;}
  const s=series[series.length-1], ch=s.chamber, tc=s.tcmd, du=s.duty, st=s.state;
  if(st===5||st===9){say('FINISHED','warn','The device ended the session.');return;}
  if(ch==null||tc==null){say('HEATING','idle','Warming up, nothing to judge yet.');return;}
  const gap=tc-ch;
  const back=series[Math.max(0,series.length-8)];
  const falling=back&&back.chamber!=null&&ch<back.chamber-1.5;
  if(du!=null&&du<13&&gap>30&&falling)
    say('IDLING','bad','Heater has stopped pushing and the heat is dropping. Something is wrong.');
  else if(gap<15)
    say('TOO CLOSE','bad','Coil is barely above the heat. It will undershoot.');
  else if(gap>55)
    say('PUSHING','warn','Working hard, still climbing. Fine, just early.');
  else if(du!=null&&du<13)
    say('COASTING','warn','Heater easing off. Fine while the heat is still rising.');
  else
    say('GOOD','good','Holding the coil above the heat, as it should.');
}
async function tick(){
  try{
    const j=await (await fetch('/samples',{cache:'no-store'})).json();
    series=j.samples||[];
    M.firstChild.textContent = j.soc!=null?('battery '+j.soc.toFixed(0)+'%  '):'';
    judge();
    const [lo,hi]=range(.15);
    line('spark',[['chamber','#e2603f'],['target','#8b93a7']],lo,hi);
    if(document.getElementById('more').classList.contains('on'))
      line('det',[['target','#8b93a7'],['tcmd','#c9a227'],['chamber','#e2603f']],lo,hi);
  }catch(e){ S.textContent='Lost the page feed.'; }
  setTimeout(tick,400);
}
tick();
</script></body></html>"""


class LivePlot:
    def __init__(self, port: int = PORT, open_browser: bool = True):
        self.port = port
        self.open_browser = open_browser
        self.samples: deque = deque(maxlen=KEEP)
        self.soc = None
        self.state = None
        self.alive = True
        self._lock = threading.Lock()
        self._srv = None

    def publish(self, t, target_f=None, chamber_f=None, tcmd_f=None,
                duty=None, soc=None, state=None):
        with self._lock:
            self.samples.append({
                "t": round(float(t), 2),
                "target": None if target_f is None else round(float(target_f), 1),
                "chamber": None if chamber_f is None else round(float(chamber_f), 1),
                "tcmd": None if tcmd_f is None else round(float(tcmd_f), 1),
                "duty": None if duty is None else round(float(duty), 1),
                "state": state,
            })
            if soc is not None:
                self.soc = soc
            if state is not None:
                self.state = state
        return self

    def close(self):
        self.alive = False

    def _payload(self) -> bytes:
        with self._lock:
            body = {"alive": self.alive, "soc": self.soc, "state": self.state,
                    "samples": list(self.samples)}
        return json.dumps(body).encode()

    def start(self):
        page = PAGE.encode()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path.startswith("/samples"):
                    data, ctype = self._outer._payload(), "application/json"
                else:
                    data, ctype = page, "text/html; charset=utf-8"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        Handler._outer = self
        self._srv = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self._srv.daemon_threads = True
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{self.port}/"
        print(f"live graph: {url}", flush=True)
        # Put it on the operator's screen without them asking. Detached so a
        # browser that blocks or barfs cannot hold up the BLE thread.
        if self.open_browser:
            try:
                import shutil
                import subprocess
                exe = shutil.which("xdg-open")
                if exe:
                    subprocess.Popen([exe, url], stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, start_new_session=True)
            except Exception:
                pass
        return self

    def stop(self):
        self.alive = False
        if self._srv:
            self._srv.shutdown()


if __name__ == "__main__":
    import time
    live = LivePlot().start()
    print("publishing synthetic samples; Ctrl-C to stop", flush=True)
    try:
        for i in range(400):
            live.publish(i * 0.5, target_f=520, chamber_f=480 + (i % 40),
                         tcmd_f=520 + (i % 7), duty=(i * 3) % 100, soc=80 - i * 0.05,
                         state=8)
            time.sleep(0.5)
    except KeyboardInterrupt:
        live.stop()
