import numpy as np, wave
SR=44100; DUR=60.0; N=int(SR*DUR)
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


MAP=[[0,4,0,2.3],[4,5.6,2.3,3.1],[5.6,7.0,3.1,3.9],[10.2,11.8,3.9,5.0],[11.8,19.8,5.0,9.0],[23.8,25.6,9.0,9.9],[25.6,27.0,9.9,10.6],[27.0,36.5,10.6,16.0],[36.5,44.5,16.0,20.0],[44.5,50.0,20.0,24.0],[50.0,56.0,24.0,28.0],[56.0,60.0,28.0,30.0]]
def remap(o):
    for a,b,c,d in MAP:
        if c<=o<d or (o>=d and d==30.0): return a+(o-c)*(b-a)/(d-c)
    return o
_add=add
def add(sig,at,gain=1.0,pan=0.0): _add(sig,remap(at),gain,pan)
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


add=_add
# new scenes (new-time)
for s in [7.2,7.6,8.1]: add(lpv(noise(.25),2500)*env(int(.25*SR),.01,.1),s,.18)
add(thud(90,.2),7.9,.25)
mur=lpv(noise(1.6),700)*(0.6+0.4*np.sin(2*np.pi*3.1*t_(1.6)))*env(int(1.6*SR),.2,.3); add(mur,8.6,.10)
for s in np.arange(8.7,9.7,.4): add(lpv(noise(.08),500)*env(int(.08*SR),.002,None,.02),s,.3)
add(lpv(noise(4.0),500)*env(int(4.0*SR),.3,.5),19.8,.06)
for s in np.arange(19.9,20.7,.4): add(lpv(noise(.08),500)*env(int(.08*SR),.002,None,.02),s,.3)
add(blip(note(62),.3),21.2,.06); add(blip(note(58),.4),21.45,.06)
sfxmix=np.stack([L,R],1)
np.save('sfx.npy',sfxmix)
print('sfx ok',np.abs(sfxmix).max())
