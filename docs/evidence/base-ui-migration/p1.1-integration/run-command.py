import sys, pathlib, subprocess, datetime, json
out=pathlib.Path('/root/.orbit/worktrees/aa737ee0-40f5-5381-8a38-f4ce4a64335e/docs/evidence/base-ui-migration/p1.1-integration')
name,cwd,command=sys.argv[1:]
record={'name':name,'cwd':cwd,'command':command,'start':datetime.datetime.now(datetime.timezone.utc).isoformat()}
for key,arg in [('commit','HEAD'),('tree','HEAD^{tree}')]:
 record[key]=subprocess.check_output(['git','rev-parse',arg],cwd=cwd,text=True).strip()
record['trackedBefore']=subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=cwd,text=True)
with (out/(name+'.txt')).open('w') as log:
 p=subprocess.run(['bash','-c',command],cwd=cwd,stdout=log,stderr=subprocess.STDOUT)
record['exitCode']=p.returncode
record['end']=datetime.datetime.now(datetime.timezone.utc).isoformat()
record['trackedAfter']=subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=cwd,text=True)
(out/(name+'.json')).write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
print((out/(name+'.txt')).read_text()[-5000:])
sys.exit(p.returncode)
