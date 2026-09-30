import wave,numpy as np
SR=44100;N=SR*60
def rd(p,ch):
    w=wave.open(p);a=np.frombuffer(w.readframes(w.getnframes()),np.int16)/32767.
    return a.reshape(-1,ch)
nar=rd('narr.wav',1)[:,0]; mus=rd('music.wav',2); sfx=np.load('sfx.npy')
# segment the narration (same detection as before)
win=int(.02*SR);e=np.sqrt(np.convolve(nar**2,np.ones(win)/win,'same'));idx=np.flatnonzero(e>0.012)
segs=[];s=p=idx[0]
for k in idx[1:]:
    if k-p>int(.45*SR): segs.append((s,p));s=k
    p=k
segs.append((s,p)); assert len(segs)==26,len(segs)
PLACE=[0.4,2.5,4.5,5.75,7.3,8.9,10.35,11.95,13.45,15.6,20.3,23.95,27.1,30.2,33.3,34.5,36.8,38.0,39.6,41.6,44.8,47.55,50.9,54.0,56.3,56.95]
V_=np.zeros(N)
pad=int(.06*SR)
for (a,b),at in zip(segs,PLACE):
    clip=nar[max(0,a-pad):b+pad].copy(); f=int(.02*SR); clip[:f]*=np.linspace(0,1,f); clip[-f:]*=np.linspace(1,0,f)
    i=int(at*SR); j=min(N,i+len(clip)); V_[i:j]+=clip[:j-i]
    if i+len(clip)>N: print('overflow at',at)
# ducking envelope from voice
ve=np.sqrt(np.convolve(V_**2,np.ones(int(.05*SR))/int(.05*SR),'same'))
active=(ve>0.01).astype(float)
k=int(.35*SR); sm=np.convolve(active,np.ones(k)/k,'same'); sm=np.clip(sm*1.5,0,1)
duck=1-0.55*sm
mus=mus[:N] if len(mus)>=N else np.vstack([mus,np.zeros((N-len(mus),2))])
fade=np.ones(N); fo=int(1.2*SR); fade[-fo:]=np.linspace(1,0,fo)
mix=np.zeros((N,2))
mix+=mus*(0.55*duck*fade)[:,None]
mix+=sfx[:N]*0.55
mix+=np.stack([V_,V_],1)*1.25
mix=np.tanh(mix*1.1)/np.tanh(1.1); mix/=np.max(np.abs(mix))/0.9
with wave.open('final.wav','wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes((mix*32767).astype(np.int16).tobytes())
print('mixed; voice rms',np.sqrt((V_**2).mean()))
