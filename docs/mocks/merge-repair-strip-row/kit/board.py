from PIL import Image, ImageDraw, ImageFont
import sys
F='/var/tmp/qap-mock/fonts/'
import glob
reg=[f for f in glob.glob(F+'*') if 'Inter' in f and ('Regular' in f or 'Variable' in f)] or glob.glob(F+'*')
font=lambda s: ImageFont.truetype(F+'Inter.ttf', s)
S='/var/tmp/rpr-mock/shots/'
def sc(n,f=0.5):
    im=Image.open(S+n).convert('RGB'); return im.resize((int(im.width*f),int(im.height*f)), Image.LANCZOS)
W=3000; blocks=[]
def text(lines, size=34, color=(30,30,30), pad=14):
    h=sum(int(size*1.45) for _ in lines)+pad*2
    im=Image.new('RGB',(W,h),'white'); d=ImageDraw.Draw(im); y=pad
    for l in lines:
        c=color; s=size
        if l.startswith('#'): l=l[1:]; s=int(size*1.35); c=(0,0,0)
        d.text((40,y),l,font=font(s),fill=c); y+=int(size*1.45)
    return im
def row(ims, labels):
    h=max(i.height for i in ims)+60; im=Image.new('RGB',(W,h),'white'); d=ImageDraw.Draw(im); x=40
    for i,l in zip(ims,labels):
        d.text((x,6),l,font=font(32),fill=(90,90,90)); im.paste(i,(x,52)); d.rectangle([x-1,51,x+i.width,52+i.height],outline=(200,200,200)); x+=i.width+60
    return im
blocks.append(text(['#Merge repair in the parking strip  — web, real session page, your 11-14 state (10 commits to push, repair running)'],30))
blocks.append(row([sc('01-today.png'),sc('02-fix.png')],['1. Today (main): composer pushed below the window','2. Bug fix (ready, uncommitted): commit lists scroll inside, max 28vh']))
blocks.append(row([sc('03-row.png'),sc('04-row-open.png')],['3. A, folded: one row of the branch bar, like Tasks','4. A, opened with the expand arrow: today\'s panel (with 2.) under the row']))
st=sc('05-all.png',0.9); ph=[sc('06-phone-today.png',0.5),sc('06-phone.png',0.5)]
blocks.append(row([st]+ph,['5. The folded row in each repair-loop state','6. Phone today','Phone, A folded']))
blocks.append(text(['#Choices (recommended first)',
 'D1  The folded row carries the next step (Open / Merge into main / Continue repair / Reply / Resolve), as in 5.   ·  alt: only the expand arrow and the row opens the session',
 'D2  The row stays folded while the repair runs or Orbit checks; it opens itself once when a result needs you (ready / conflicts / reply / failed),',
 '      so the push list is seen before Merge   ·  alt: always folded until you press the expand arrow',
 'D3  Web, iOS, macOS and Android together, the way the parking strip moved on 10-28   ·  alt: web first',
 'Notes: no new server field: the row reads mergeRecovery + mergeRepairSession as the panel does. Opened, the panel drops its own repair card (the row says it).',
 'Frames 3.–6. are drawn over the same build by inserting the row at capture time; icons are placeholders for the antd ones.'],30))
H=sum(b.height for b in blocks); out=Image.new('RGB',(W,H),'white'); y=0
for b in blocks: out.paste(b,(0,y)); y+=b.height
out.save(sys.argv[1]); print(out.size)
