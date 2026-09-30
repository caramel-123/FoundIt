import numpy as np, wave
SR=44100; DUR=30.0; N=int(SR*DUR)
L=np.zeros(N); R=np.zeros(N)
rng=np.random.default_rng(7)
def t_(d): return np.arange(int(SR*d))/SR
def add(sig,at,gain=1.0,pan=0.0):
    i=int(at*SR); j=min(N,i+len(sig)); s=sig[:j-i]*gain
    L[i:j]+=s*(1-max(0,pan)); R[i:j]+=s*(1+min(0,pan))
def env(n,a=.005,rel=None,d=None):
    e=np.ones(n); na=max(1,int(a*SR)); e[:na]=np.linspace(0,1,na)
    if d: e*=np.exp(-np.arange(n)/SR/d)
    if rel: nr=int(rel*SR); e[-nr:]*=np.linspace(1,0,nr)
    return e
def lp(x,c):  # one-pole lowpass, c in 0..1
    y=np.zeros_like(x); a=0.0
    for i in range(len(x)): a+=c*(x[i]-a); y[i]=a
    return y
def lpv(x,c):  # vectorized-ish lowpass via cumulative trick (approx with FFT)
    X=np.fft.rfft(x); f=np.fft.rfftfreq(len(x),1/SR); X*=1/(1+(f/c)**2); return np.fft.irfft(X,len(x))
def hpv(x,c):
    X=np.fft.rfft(x); f=np.fft.rfftfreq(len(x),1/SR); X*=(f/c)**2/(1+(f/c)**2); return np.fft.irfft(X,len(x))
def note(f): return 440*2**((f-69)/12)
def pluck(freq,d=.9,bright=1.0):
    t=t_(d); s=np.sin(2*np.pi*freq*t)+.35*bright*np.sin(4*np.pi*freq*t)+.12*bright*np.sin(6*np.pi*freq*t)
    return s*env(len(t),.004,.05,d*.28)
def pad(freqs,d,a=.8,rel=1.0):
    t=t_(d); s=sum(np.sin(2*np.pi*f*t)+.5*np.sin(2*np.pi*f*1.003*t)+.3*np.sin(2*np.pi*f*2*t) for f in freqs)/len(freqs)
    return lpv(s,1800)*env(len(t),a,rel)
def bell(freq,d=1.6):
    t=t_(d); s=np.sin(2*np.pi*freq*t)+.5*np.sin(2*np.pi*freq*2.76*t)*np.exp(-t*6)+.25*np.sin(2*np.pi*freq*5.4*t)*np.exp(-t*10)
    return s*env(len(t),.002,.1,d*.35)
def noise(d): return rng.standard_normal(int(SR*d))
def click(g=1.0):
    n=noise(.012); return hpv(n,3000)*env(len(n),.0005,None,.003)*g
def whoosh(d=.45,up=True):
    n=noise(d); t=t_(d); sweep=np.linspace(0,1,len(t)) if up else np.linspace(1,0,len(t))
    lo=lpv(n,900); hi=hpv(n,2500); s=lo*(1-sweep)+hi*sweep*.6
    return s*np.sin(np.pi*np.linspace(0,1,len(t)))**2
def thud(f0=110,d=.3):
    t=t_(d); f=f0*np.exp(-t*12)+40; ph=2*np.pi*np.cumsum(f)/SR; return np.sin(ph)*env(len(t),.001,None,.09)
def kick(): return thud(130,.35)
def hat(): n=noise(.05); return hpv(n,7000)*env(len(n),.0005,None,.012)
def blip(f,d=.09): t=t_(d); return np.sin(2*np.pi*f*t*(1+.3*np.exp(-t*40)))*env(len(t),.002,None,.03)
def reverb(x,g=.3):
    y=x.copy()
    for dl,gg in [(.029,.5),(.037,.45),(.041,.42),(.053,.38),(.071,.3),(.089,.25)]:
        k=int(dl*SR); z=np.zeros_like(x)
        for rep in range(1,8):
            if k*rep>=len(x): break
            z[k*rep:]+=x[:-k*rep]*gg**rep
        y+=z*g
    return y

# ---------- MUSIC ----------
# tense 0-9: drone A minor + heartbeat pulse + tick
t=t_(9.4); drone=(np.sin(2*np.pi*note(45)*t)+.6*np.sin(2*np.pi*note(52)*t)+.4*np.sin(2*np.pi*note(57)*t*1.002))
drone=lpv(drone,600)*env(len(t),1.2,.6)*(0.55+0.45*np.clip(t/9,0,1))
add(drone,0,.15)
diss=np.sin(2*np.pi*note(58)*t_(4.2))*env(int(4.2*SR),1.5,.8); add(lpv(diss,900),5.0,.07)
for b in np.arange(.3,8.8,.72): add(thud(70,.25),b,.26); add(thud(62,.22),b+.18,.16)
for b in np.arange(0,8.9,.25): add(click(.35),b,.14,pan=.3 if int(b*4)%2 else -.3)
# riser into discovery
n=noise(1.2); add(hpv(n,1200)*np.linspace(0,1,len(n))**2,7.9,.18)
# energetic 9-24: 112 bpm, bar = 4 beats
bpm=112; beat=60/bpm; bar=4*beat
prog=[[65,69,72],[60,64,67],[67,71,74],[57,60,64]]  # F C G Am
start=9.0; k=0; tt=start
while tt<24.0:
    ch=prog[k%4]; root=ch[0]-24
    quiet = 16.0<=tt<16.9
    add(pad([note(m) for m in ch],bar+.4,.25,.35),tt,.16 if tt>9.8 else .10)
    add(pluck(note(root),bar*.9,.5),tt,.30)
    for i in range(8):
        at=tt+i*beat/2
        if at>=24: break
        m=ch[[0,1,2,1,0+0,2,1,2][i]]+12
        add(pluck(note(m),.35,1.0),at,.12 if not quiet else .05,pan=(-.25 if i%2 else .25))
    for i in range(4):
        at=tt+i*beat
        if at>=24 or at<11.9 or quiet: continue
        if i in (0,2): add(kick(),at,.75)
        else: add(hpv(noise(.12),1800)*env(int(.12*SR),.001,None,.035),at,.18)
    for i in range(8):
        at=tt+i*beat/2
        if 11.9<=at<24 and not quiet: add(hat(),at,.14,pan=.2)
    tt+=bar; k+=1
# resolution 24-30: F G C, warm
for (at,ch,d) in [(24.0,[65,69,72,77],1.4),(25.4,[67,71,74,79],1.4),(26.8,[60,64,67,72,76],3.2)]:
    add(pad([note(m) for m in ch],d+.6,.3,1.0),at,.16)
    for i,m in enumerate(ch): add(pluck(note(m+12),1.2,.8),at+i*.09,.06,pan=(i%3-1)*.3)
    add(pluck(note(ch[0]-24),d,.4),at,.22)
add(pad([note(m) for m in [48,55,60,64,67]],3.0,.4,1.6),27.4,.12)
add(reverb(bell(note(84),2.0)),28.25,.16); add(reverb(bell(note(79),2.0)),28.45,.10)

# ---------- SFX ----------
for s in np.arange(.1,1.4,.43): add(lpv(noise(.08),500)*env(int(.08*SR),.002,None,.02),s,.35,pan=-.1)
add(blip(note(60),.35)*1.0,1.55,.10); add(blip(note(56),.45),1.75,.10)
for s in np.arange(2.4,3.05,.16): add(lpv(noise(.07),1200)*env(int(.07*SR),.002,None,.02),s,.25)
for s in np.arange(3.15,3.85,.06): add(hpv(noise(.03),2000)*env(int(.03*SR),.001,None,.01),s+rng.uniform(0,.03),.12,pan=rng.uniform(-.5,.5))
add(whoosh(.5,True),4.62,.35)
for s in np.arange(5.2,5.9,.05): add(click(.8),s+rng.uniform(0,.01),.45)
add(whoosh(.2,True),5.9,.25); add(blip(note(76),.12),5.95,.18)
for i in range(18): add(blip(note(rng.choice([72,74,76,79,81])),.07),6.15+i*.085,.13,pan=rng.uniform(-.4,.4))
add(blip(note(88),.05),7.65,.1); add(blip(note(86),.05),7.9,.08)
add(lpv(noise(.6),300)*env(int(.6*SR),.05,.3),8.3,.25)
for i,f in enumerate([91,96,100]): add(bell(note(f),.6),9.2+i*.06,.05,pan=.4)
add(lpv(noise(.15),1500)*env(int(.15*SR),.003,None,.04),10.2,.25)
add(whoosh(.35,True),10.62,.2); add(reverb(bell(note(88),1.0)),10.8,.07)
for at in [11.62,12.1,12.62,12.98,14.12,17.3,19.5,21.2]: add(click(1.0),at,.5); add(blip(note(84),.04),at,.05)
n=noise(.05); sh=hpv(n,2500)*env(len(n),.001,None,.012); add(sh,12.25,.5); add(sh,12.31,.35)
for s in np.arange(13.25,14.08,.045): add(click(.8),s+rng.uniform(0,.01),.4)
add(whoosh(.5,True),14.35,.35); add(thud(160,.2),14.86,.35); add(blip(note(79),.1),14.9,.1)
add(whoosh(.35,False),15.7,.3)
t=t_(.8); buzz=np.sign(np.sin(2*np.pi*150*t))*(0.5+0.5*np.sign(np.sin(2*np.pi*12*t)))
add(lpv(buzz,500)*env(len(t),.01,.05),16.1,.22)
add(reverb(bell(note(81),.8)),16.28,.12); add(reverb(bell(note(88),.8)),16.40,.10)
add(whoosh(.35,True),16.8,.22)
for s in list(np.arange(17.85,18.5,.05))+list(np.arange(18.8,19.3,.05)): add(click(.8),s+rng.uniform(0,.01),.4)
add(whoosh(.3,False),19.75,.28)
add(pluck(note(88),.4,1.2),20.45,.14); add(pluck(note(91),.4,1.2),20.85,.14)
add(thud(90,.35),21.42,.6)
for i,f in enumerate([76,83,88]): add(reverb(bell(note(f),1.4)),21.5+i*.09,.13)
add(blip(note(84),.12),22.9,.12); add(whoosh(.3,True),23.75,.22)
for s in list(np.arange(24.05,24.6,.4))+list(np.arange(25.25,25.9,.4)): add(lpv(noise(.08),500)*env(int(.08*SR),.002,None,.02),s,.3)
for at in [24.9,26.2]: add(hpv(noise(.18),1500)*np.sin(np.pi*np.linspace(0,1,int(.18*SR)))**2,at,.12)
for i,f in enumerate([91,95,98]): add(bell(note(f),.7),26.6+i*.07,.05,pan=-.3)
add(whoosh(.5,True),27.6,.3)


# ---------- paper foley ----------
def rustle(d=.35):
    n=noise(d); t=t_(d); return hpv(lpv(n,5000),900)*np.sin(np.pi*np.linspace(0,1,len(t)))**1.5*(0.6+0.4*np.sin(2*np.pi*23*t))
for at in [2.25,3.05,3.85,4.9,8.9,9.85,10.55,15.9,19.9,23.9,27.9]: add(rustle(.4),at,.22,pan=rng.uniform(-.3,.3))
for at in [5.9,14.35,21.4,22.9,26.2]: add(hpv(noise(.05),3000)*env(int(.05*SR),.001,None,.012),at,.18)
# ---------- master ----------
mix=np.stack([L,R],1)
mix=np.tanh(mix*1.2)/np.tanh(1.2)
fade=np.ones(N); fn=int(.6*SR); fade[-fn:]=np.linspace(1,0,fn); mix*=fade[:,None]
mix/=np.max(np.abs(mix))/0.89
with wave.open('audio.wav','wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix*32767).astype(np.int16).tobytes())
print('ok', mix.shape)
