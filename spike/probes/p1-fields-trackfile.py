# p1-fields-trackfile.py - list the track sections and the computer-car line of a
# track file (layout from ArgData TrackSectionReader / ComputerCarLineReader).
#   python3 probes/p1-fields-trackfile.py ../original/f1ct12.dat   (Monza)
import struct, sys
ARGS={0x80:2,0x81:2,0x82:2,0x83:1,0x84:1,0x85:3,0x86:1,0x87:1,0x88:2,0x89:2,0x8a:6,0x8b:6,0x8c:2,0x8d:2,0x8e:3,0x8f:3,0x90:2,0x91:2,0x92:2,0x93:2,0x94:2,0x95:2,0x96:1,0x97:1,0x98:2,0x99:2,0x9a:3,0x9b:1,0x9c:1,0x9d:1,0x9e:1,0x9f:1,0xa0:1,0xa1:1,0xa2:1,0xa3:1,0xa4:1,0xa5:1,0xa6:3,0xa7:3,0xa8:1,0xa9:2,0xaa:4,0xab:3,0xac:5}
d=open(sys.argv[1],'rb').read()
td=struct.unpack_from('<h',d,0x100c)[0]+0x1010
kerb=d[td+18]; hdr=32 if kerb==4 else 28
p=td+hdr
secs=[]
while True:
  b1,b2=d[p],d[p+1]; p+=2
  if b1==255 and b2==255: break
  if b2>0:
    p+=2*(ARGS[b2]-1); continue
  L=b1; C,H,F=struct.unpack_from('<hhh',d,p); p+=6; rv,lv=d[p],d[p+1]; p+=2
  secs.append((L,C,H,F))
start=0; out=[]
for i,(L,C,H,F) in enumerate(secs):
  out.append((i,start,L,C)); start+=L
print('sections',len(secs),'total TLU',start)
# cc line
cc=[]; q=p
first=d[q]; q+=2; disp,corr,rad=struct.unpack_from('<hhh',d,q); q+=6; cc.append((first,corr,rad))
while True:
  b1,b2=d[q],d[q+1]; q+=2
  if b2==0x40:
    c,hr,lr=struct.unpack_from('<hhh',d,q); q+=6; cc.append((b1,c,(hr,lr)))
  else:
    c,r=struct.unpack_from('<hh',d,q); q+=4; cc.append((b1,c,r))
  if struct.unpack_from('<h',d,q)[0]==0: break
s=0
print('cc line sections',len(cc))
for i,(L,c,r) in enumerate(cc): print('cc',i,'start',s,'len',L,'radius',r); s+=L
for i,st,L,C in out: print('sec',i,'start',st,'len',L,'curv',C)
